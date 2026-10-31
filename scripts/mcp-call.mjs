// 调试用：node scripts/mcp-call.mjs <tool> [args.json]   以 UTF-8 走 stdio 调用 ScreenLens MCP 的一个工具
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [tool = "list_displays", argsFile] = process.argv.slice(2);
const args = argsFile ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
const p = spawn(process.execPath, ["mcp/screenlens-mcp.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
let exitCode = 0;

function finish(code) {
  exitCode = code;
  p.stdin.end();
}

p.stdout.setEncoding("utf8");
p.stdout.on("data", (c) => {
  buf += c;
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== 2) continue;
    if (msg.error) {
      console.error(`MCP error ${msg.error.code ?? ""}: ${msg.error.message}`);
      finish(1);
      continue;
    }
    const content = msg.result?.content ?? [];
    for (const c of content) {
      if (c.type === "text") console.log(c.text);
      else if (c.type === "image") {
        if (!existsSync(".e2e")) mkdirSync(".e2e", { recursive: true });
        writeFileSync(".e2e/mcp-shot.jpg", Buffer.from(c.data, "base64"));
        console.log("image -> .e2e/mcp-shot.jpg");
      }
    }
    // 工具返回 isError 时也让退出码非零，便于脚本判断
    finish(msg.result?.isError ? 1 : 0);
  }
});

// 只有当 MCP 进程真正退出后才结束本进程，避免 stdout 未刷完就 exit
p.on("close", () => process.exit(exitCode));
p.on("error", (e) => {
  console.error(`spawn failed: ${e.message}`);
  process.exit(1);
});

const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-call", version: "0" } } });
send({ id: 2, method: "tools/call", params: { name: tool, arguments: args } });

// 兜底：长时间无响应则超时退出
setTimeout(() => {
  console.error("timeout: 无响应");
  p.kill();
  process.exit(1);
}, 180000).unref();

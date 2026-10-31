// 调试用：node scripts/mcp-call.mjs <tool> [args.json]   以 UTF-8 走 stdio 调用 ScreenLens MCP 的一个工具
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [tool = "list_displays", argsFile] = process.argv.slice(2);
const args = argsFile ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
const p = spawn(process.execPath, ["mcp/screenlens-mcp.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
p.stdout.setEncoding("utf8");
p.stdout.on("data", (c) => {
  buf += c;
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id !== 2) continue;
    for (const c of msg.result?.content ?? []) {
      if (c.type === "text") console.log(c.text);
      if (c.type === "image") {
        writeFileSync(".e2e/mcp-shot.jpg", Buffer.from(c.data, "base64"));
        console.log("image -> .e2e/mcp-shot.jpg");
      }
    }
    if (msg.error) console.error(msg.error);
    p.stdin.end();
  }
});
const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-call", version: "0" } } });
send({ id: 2, method: "tools/call", params: { name: tool, arguments: args } });

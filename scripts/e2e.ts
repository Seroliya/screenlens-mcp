/**
 * 端到端验证：MCP stdio → 自动启动 ScreenLens → 截屏(带网格) → 让视觉模型输出标注 → annotate 画到屏幕。
 * 运行：node scripts/run-e2e.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/shared/prompt";
import { splitAnnotations } from "../src/shared/annotations";

const OUT = join(process.cwd(), ".e2e");
mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m![1], m![2]]),
);

const mcp = spawn(process.execPath, ["mcp/screenlens-mcp.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiters = new Map<number, (v: any) => void>();
mcp.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    waiters.get(msg.id)?.(msg);
  }
});
let seq = 0;
const rpc = (method: string, params: unknown = {}) =>
  new Promise<any>((res) => {
    const id = ++seq;
    waiters.set(id, res);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const t0 = Date.now();
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
console.log("initialize:", init.result.serverInfo);
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tools = await rpc("tools/list");
console.log("tools:", tools.result.tools.map((t: any) => t.name).join(", "));

const cap = await rpc("tools/call", { name: "screen_capture", arguments: {} });
if (cap.result.isError) throw new Error(cap.result.content[0].text);
const [meta, img] = cap.result.content;
console.log(meta.text, `\n(${((Date.now() - t0) / 1000).toFixed(1)}s，含启动应用)`);
writeFileSync(join(OUT, "capture-grid.jpg"), Buffer.from(img.data, "base64"));

const question = process.argv[2] || "我想打开 Windows 开始菜单，应该点哪里？另外请圈出任务栏右下角的时钟。";
const t1 = Date.now();
const res = await fetch(env.SCREENLENS_BASE_URL.replace(/\/$/, "") + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${env.SCREENLENS_API_KEY}` },
  body: JSON.stringify({
    model: env.SCREENLENS_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: buildSystemPrompt({ grid: true }) },
      {
        role: "user",
        content: [
          { type: "text", text: "[图片 1：屏幕截图]" },
          { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } },
          { type: "text", text: question },
        ],
      },
    ],
  }),
});
const j: any = await res.json();
if (!res.ok) throw new Error(JSON.stringify(j));
const content: string = j.choices[0].message.content;
const { text, annotations } = splitAnnotations(content);
console.log(`\n--- 模型回答 (${((Date.now() - t1) / 1000).toFixed(1)}s) ---\n${text}\n--- 解析到标注 ${annotations.length} 个 ---\n${JSON.stringify(annotations)}`);
writeFileSync(join(OUT, "answer.md"), content);

if (annotations.length) {
  const shotId = /shot_id: (\S+)/.exec(meta.text)![1];
  const ann = await rpc("tools/call", { name: "annotate", arguments: { shot_id: shotId, annotations, seconds: 0 } });
  console.log("annotate:", ann.result.content[0].text);
}
mcp.stdin.end();

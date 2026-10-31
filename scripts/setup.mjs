// 一键安装：npm install 之后执行  node scripts/setup.mjs [dsh] [codex] [claude]
// 1) 构建 dist（esbuild）2) 把 MCP 接入指定的 Agent 客户端（不传客户端则只显示接入状态）
import { spawnSync } from "node:child_process";

const run = (args) => {
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status) process.exit(r.status ?? 1);
};

run(["scripts/build.mjs"]);

const clients = process.argv.slice(2);
if (!clients.length) {
  console.log("\n构建完成。接入 Agent 客户端（可多选）：");
  console.log("  node scripts/setup.mjs dsh codex claude\n");
}
run(["scripts/install-mcp.mjs", ...clients]);

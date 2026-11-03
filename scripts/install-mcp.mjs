// 命令行一键接入：node scripts/install-mcp.mjs dsh codex claude workbuddy   （不带参数只显示状态）
import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

await esbuild.build({ entryPoints: ["src/main/mcp-install.ts"], bundle: true, platform: "node", format: "esm", outfile: ".e2e/mcp-install.mjs", logLevel: "warning" });
const m = await import(pathToFileURL(resolve(".e2e/mcp-install.mjs")).href);
const launch = {
  command: resolve("node_modules", "electron", "dist", readFileSync(join("node_modules", "electron", "path.txt"), "utf8").trim()),
  script: resolve("mcp", "screenlens-mcp.mjs"),
};
for (const c of process.argv.slice(2)) {
  try {
    await m.installMcp(c, launch);
  } catch (e) {
    console.error(`${c}: ${e.message}`);
  }
}
for (const s of m.mcpStatus()) console.log(`${s.name.padEnd(24)} ${s.detected ? "已安装" : "未检测到"}  ${s.registered ? "✓ 已接入" : "未接入"}  ${s.configPath}`);

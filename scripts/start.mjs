// 启动 ScreenLens。去掉宿主可能注入的 ELECTRON_RUN_AS_NODE（在 DSH / VS Code 终端里运行时会有）。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const exe = join("node_modules", "electron", "dist", readFileSync(join("node_modules", "electron", "path.txt"), "utf8").trim());
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (code) {
    console.error(`\nScreenLens 异常退出：code=${code} (0x${(code >>> 0).toString(16)}) signal=${signal ?? "-"}`);
    console.error("若在 DSH/Codex 沙箱写过的目录里运行，检查 node_modules\\electron\\dist 是否带 Low 完整性标签：");
    console.error('  icacls node_modules\\electron\\dist\\electron.exe   （修复：icacls node_modules\\electron\\dist /setintegritylevel "(OI)(CI)M" /T）');
  }
  process.exit(code ?? 0);
});

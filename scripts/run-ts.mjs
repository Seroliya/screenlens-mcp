// 运行一个 TS 脚本：node scripts/run-ts.mjs <file.ts> [args...]
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const [file, ...args] = process.argv.slice(2);
const out = `.e2e/${basename(file, ".ts")}.mjs`;
await esbuild.build({ entryPoints: [file], bundle: true, platform: "node", format: "esm", target: "node22", outfile: out, external: ["electron"], logLevel: "warning" });
const r = spawnSync(process.execPath, [out, ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);

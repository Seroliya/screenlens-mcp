import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";

await esbuild.build({
  entryPoints: ["scripts/e2e.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: ".e2e/e2e.mjs",
  logLevel: "warning",
});
const r = spawnSync(process.execPath, [".e2e/e2e.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);

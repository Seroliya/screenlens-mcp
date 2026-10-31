import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";

const common = { bundle: true, logLevel: "warning" };
await esbuild.build({
  ...common,
  entryPoints: { pages: "scripts/harness/pages.tsx" },
  outdir: ".e2e",
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  assetNames: "assets/[name]-[hash]",
});
await esbuild.build({ ...common, entryPoints: ["scripts/visual-test.ts"], outfile: ".e2e/visual-test.mjs", platform: "node", format: "esm", target: "node22" });
const r = spawnSync(process.execPath, [".e2e/visual-test.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);

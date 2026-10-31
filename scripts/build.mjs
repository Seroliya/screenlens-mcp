import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");

const common = { bundle: true, sourcemap: dev ? "inline" : false, minify: !dev, logLevel: "info", legalComments: "none" };

const configs = [
  {
    ...common,
    entryPoints: { main: "src/main/index.ts", preload: "src/main/preload.ts", "overlay-preload": "src/main/overlay-preload.ts" },
    outdir: "dist",
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  },
  {
    ...common,
    entryPoints: { app: "src/renderer/main.tsx" },
    outdir: "dist/renderer",
    platform: "browser",
    format: "iife",
    target: "chrome130",
    jsx: "automatic",
    loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
    assetNames: "assets/[name]-[hash]",
  },
  {
    ...common,
    entryPoints: { overlay: "src/overlay/overlay.ts" },
    outdir: "dist/overlay",
    platform: "browser",
    format: "iife",
    target: "chrome130",
  },
];

function copyStatic() {
  mkdirSync("dist/renderer", { recursive: true });
  mkdirSync("dist/overlay", { recursive: true });
  cpSync("src/renderer/index.html", "dist/renderer/index.html");
  cpSync("src/overlay/overlay.html", "dist/overlay/overlay.html");
}

copyStatic();
if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
  console.log("watching…");
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}

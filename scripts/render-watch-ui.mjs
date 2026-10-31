// 无头渲染观察面板：node scripts/render-watch-ui.mjs
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

await esbuild.build({
  entryPoints: { pages: "scripts/harness/pages.tsx" }, outdir: ".e2e", bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" }, assetNames: "assets/[name]-[hash]", logLevel: "warning",
});
const u = (f) => pathToFileURL(resolve(".e2e", f)).href;
const settings = {
  baseUrl: "https://api.deepseek.com", apiKey: "x", model: "deepseek-flash", temperature: 0.4, proxy: "", maxImageSide: 1600, maxHistoryImages: 3,
  drawGrid: true, autoCapture: true, overlaySeconds: 15, hideFromCapture: true, screenTarget: "cursor", hotkeyCapture: "Alt+Shift+S",
  hotkeyToggle: "Alt+Shift+A", alwaysOnTop: false, extraPrompt: "", mcpPromptDismissed: true,
  watchScope: "window", watchWindowId: "window:1:0", watchWindowName: "crawler.py — study — Visual Studio Code", watchFgFilter: true,
  watchFgAllow: "Code,WindowsTerminal,python", watchBlocklist: "KeePass,WeChat", watchSensitivity: 5, watchSettleMs: 1500, watchMinInterval: 20,
  watchPeriodicMin: 5, watchHourlyCap: 30, watchMaxChange: 0, watchTask: "我在学 Python 写爬虫，出现报错或者我卡住时提醒我",
};
const windows = [
  { id: "window:1:0", name: "crawler.py — study — Visual Studio Code", thumb: u("watch-bug.png") },
  { id: "window:2:0", name: "Windows PowerShell", thumb: u("watch-ok.png") },
  { id: "window:3:0", name: "新闻 - Microsoft Edge", thumb: u("ui.png") },
];
const watchState = { running: true, scopeLabel: "窗口「crawler.py — study — Visual Studio Code」", paused: null, ratio: 0.031, phase: "有零星变化，未达阈值", sent: 7, silent: 5, spoke: 2, lastSentAt: Date.now() - 140000, hourCount: 7 };
const data = { page: "ui", home: true, openWatch: true, settings, windows, watchState, list: [], shots: {} };
writeFileSync(".e2e/watch-ui.html", `<!doctype html><meta charset=utf-8><link rel=stylesheet href=pages.css><body><script>window.__DATA=${JSON.stringify(data)}</script><script src=pages.js></script>`);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1180,900", "--virtual-time-budget=4000", "--allow-file-access-from-files", `--screenshot=${resolve(".e2e/watch-ui.png")}`, u("watch-ui.html")], { stdio: "ignore" });
console.log("-> .e2e/watch-ui.png");

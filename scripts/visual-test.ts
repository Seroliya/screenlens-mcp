/**
 * 不启动 Electron 的可视化端到端测试：
 *   真实截屏 → 真实网格代码加网格 → 真实系统提示词问视觉模型 → 解析标注 → 真实绘制代码画在截图上 → 真实 App UI 渲染对话
 * 所有页面在无头 Edge 里跑，结果截图写到 .e2e/。
 * 运行：node scripts/run-visual.mjs ["问题"]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSystemPrompt } from "../src/shared/prompt";
import { splitAnnotations } from "../src/shared/annotations";

const OUT = resolve(".e2e");
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync)!;
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/).map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1], m![2]]),
);
const fileUrl = (p: string) => pathToFileURL(p).href;
const pngSize = (p: string) => {
  const b = readFileSync(p);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

function page(name: string, data: unknown, w: number, h: number, budget = 3000) {
  const html = join(OUT, `${name}.html`);
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="pages.css"><body><script>window.__DATA=${JSON.stringify(data)}</script><script src="pages.js"></script>`,
  );
  const png = join(OUT, `${name}.png`);
  execFileSync(EDGE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--window-size=${w},${h}`, `--virtual-time-budget=${budget}`, "--allow-file-access-from-files",
    `--screenshot=${png}`, fileUrl(html),
  ], { stdio: "ignore" });
  return png;
}

// 1. 截屏（PowerShell，DPI 无感知 → 逻辑分辨率）
const shot = join(OUT, "screen.png");
execFileSync("powershell", ["-NoProfile", "-Command",
  `Add-Type -AssemblyName System.Drawing,System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${shot}')`]);
const { w, h } = pngSize(shot);
console.log(`截屏 ${w}×${h}`);

// 2. 加网格（真实 drawGrid）
const maxSide = 1600;
const s = Math.min(1, maxSide / Math.max(w, h));
const gw = Math.round(w * s), gh = Math.round(h * s);
const gridPng = page("grid", { page: "grid", img: fileUrl(shot), maxSide }, gw, gh);
console.log(`网格图 ${gw}×${gh} -> ${gridPng}`);

// 3. 问模型
const question = process.argv[2] || "我想打开 Windows 开始菜单，应该点哪里？另外请圈出任务栏右下角的时钟，并框出屏幕上最大的那个窗口的标题栏。";
const t1 = Date.now();
const res = await fetch(env.SCREENLENS_BASE_URL.replace(/\/$/, "") + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${env.SCREENLENS_API_KEY}` },
  body: JSON.stringify({
    model: env.SCREENLENS_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: buildSystemPrompt({ grid: true }) },
      { role: "user", content: [
        { type: "text", text: `[图片 1：屏幕截图（屏幕 1），原始尺寸 ${w}×${h}]` },
        { type: "image_url", image_url: { url: "data:image/png;base64," + readFileSync(gridPng).toString("base64") } },
        { type: "text", text: question },
      ] },
    ],
  }),
});
const j: any = await res.json();
if (!res.ok) throw new Error(JSON.stringify(j));
const content: string = j.choices[0].message.content;
const { text, annotations } = splitAnnotations(content);
console.log(`\n--- 模型回答（${((Date.now() - t1) / 1000).toFixed(1)}s）---\n${text}\n--- 标注 ${annotations.length} 个 ---\n${JSON.stringify(annotations)}\n`);
writeFileSync(join(OUT, "answer.md"), content);

// 4. 把标注画在干净截图上（真实 drawAnnotations，与屏幕覆盖层同一份代码）
const annW = 1600, annH = Math.round((1600 * h) / w);
console.log("标注效果 ->", page("annot", { page: "annot", img: fileUrl(shot), annotations, w: annW, h: annH }, annW, annH));

// 5. 渲染完整 App UI（mock api）
const settings = {
  baseUrl: "https://api.deepseek.com", apiKey: "x", model: env.SCREENLENS_MODEL, temperature: 0.4, proxy: "", maxImageSide: 1600,
  maxHistoryImages: 3, drawGrid: true, autoCapture: true, overlaySeconds: 15, hideFromCapture: true, screenTarget: "cursor",
  hotkeyCapture: "Alt+Shift+S", hotkeyToggle: "Alt+Shift+A", alwaysOnTop: false, extraPrompt: "",
};
const now = Date.now();
const shotRef = { id: "s1", source: "screen", width: w, height: h, displayId: 1, label: "屏幕 1", createdAt: now };
const mdDemo = "\n\n---\n补充示例（Markdown 渲染测试）：\n\n| 项目 | 说明 |\n|---|---|\n| 公式 | $E=mc^2$ |\n\n$$\\int_0^1 x^2\\,dx=\\tfrac13$$\n\n```python\nprint(\"hello\")\n```";
const conversation = {
  id: "c1", title: "开始菜单和时钟在哪", createdAt: now, updatedAt: now,
  messages: [
    { id: "m1", role: "user", content: question, shots: [shotRef], createdAt: now },
    { id: "m2", role: "assistant", content: text + mdDemo + "\n\n```annotations\n" + JSON.stringify(annotations) + "\n```", annotations, targetShotIds: ["s1"], model: env.SCREENLENS_MODEL, createdAt: now },
  ],
};
const list = [
  { id: "c1", title: conversation.title, createdAt: now, updatedAt: now },
  { id: "c2", title: "解释报错信息", createdAt: now - 3600e3, updatedAt: now - 3600e3, pinned: true },
  { id: "c3", title: "摄像头里的电路板", createdAt: now - 86400e3, updatedAt: now - 86400e3 },
];
console.log("UI ->", page("ui", { page: "ui", settings, conversation, list, shots: { s1: fileUrl(shot) } }, 1180, 820, 6000));

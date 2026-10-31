/**
 * 无头浏览器测试页：用真实的渲染代码（网格、标注绘制、整个 App UI）+ mock 的 window.api。
 * window.__DATA 由 visual-test 生成：{ page: "grid" | "annot" | "ui", ... }
 */
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import "../../src/renderer/styles.css";
import { ANNOTATION_CSS, drawAnnotations } from "../../src/shared/draw";
import { drawGrid } from "../../src/renderer/lib/image";
import { App } from "../../src/renderer/App";

const D = (window as any).__DATA;
const style = document.createElement("style");
style.textContent = ANNOTATION_CSS + "body{margin:0;background:#000}";
document.head.appendChild(style);

function loadImg(src: string) {
  return new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

async function gridPage() {
  const img = await loadImg(D.img);
  const s = Math.min(1, D.maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * s), H = Math.round(img.naturalHeight * s);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  c.style.display = "block";
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, W, H);
  drawGrid(ctx, W, H);
  document.body.appendChild(c);
}

async function annotPage() {
  const img = await loadImg(D.img);
  img.style.cssText = "display:block;width:100vw;height:100vh";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  document.body.append(img, svg);
  // 无头模式下加载时的 innerHeight 与截图时不同：用固定坐标系 + CSS 拉伸（viewBox 等比缩放）
  const W = D.w, H = D.h;
  drawAnnotations(svg, D.annotations, { width: W, height: H, scale: Math.max(0.8, Math.min(1.6, W / 1600)), animate: !!D.animate });
  svg.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh";
}

function uiPage() {
  (window as any).__shotUrl = (id: string) => D.shots[id];
  const conv = D.conversation;
  const noop = async () => undefined;
  (window as any).api = {
    settings: { get: async () => D.settings, set: async (p: any) => ({ settings: { ...D.settings, ...p }, failedHotkeys: [] }) },
    conv: { list: async () => D.list, get: async () => conv, save: noop, delete: noop },
    displays: async () => [{ id: 1, label: "", bounds: { x: 0, y: 0, width: 2560, height: 1600 }, scaleFactor: 1.5, primary: true }],
    capture: { screen: noop, dataUrl: noop },
    shotDataUrl: noop,
    overlay: { show: noop, clear: noop },
    chat: { start: noop, abort: noop, title: noop, onDelta: () => () => {} },
    models: async () => [],
    mcp: { status: async () => D.mcp ?? [], install: noop },
    watch: {
      start: noop, stop: noop, result: noop,
      state: async () => D.watchState ?? { running: false, scopeLabel: "", paused: null, ratio: 0, phase: "未开启", sent: 0, silent: 0, spoke: 0, lastSentAt: 0, hourCount: 0 },
      windows: async () => D.windows ?? [],
      onTrigger: () => () => {},
      onState: () => () => {},
    },
    deleteShot: noop,
    app: { mcpInfo: async () => ({ script: "C:/ScreenLens/mcp/screenlens-mcp.mjs", exists: true }), openPath: noop, userData: noop, hide: noop },
    on: new Proxy({}, { get: () => () => () => {} }),
    serveRpc: () => {},
  };
  const root = document.createElement("div");
  root.id = "root";
  root.style.height = "100vh";
  document.body.appendChild(root);
  createRoot(root).render(<App />);
  // 打开第一个对话
  if (!D.home) setTimeout(() => (document.querySelector(".conv") as HTMLElement | null)?.click(), 300);
  if (D.openWatch) setTimeout(() => (document.querySelector(".watch-pill") as HTMLElement | null)?.click(), 400);
}

({ grid: gridPage, annot: annotPage, ui: uiPage } as Record<string, () => void>)[D.page]();

import type { Annotation } from "./types";
import { colorOf } from "./annotations";
import { bubbleLayout, bubbleTail, estimateWidth } from "./annot-layout";

const FONT = "Inter, 'Microsoft YaHei UI', sans-serif";

/**
 * 把归一化(0~1000)标注渲染到 SVG。overlay 窗口与应用内查看器共用。
 * 纯 DOM 实现，不依赖 React。
 */
const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

export interface DrawOptions {
  width: number;
  height: number;
  /** 线宽缩放（缩略图里画细一点） */
  scale?: number;
  animate?: boolean;
  /** 只画编号不画文字标签 */
  compact?: boolean;
}

let filterSeq = 0;

export function drawAnnotations(svg: SVGSVGElement, anns: Annotation[], o: DrawOptions) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const { width: W, height: H } = o;
  const k = o.scale ?? 1;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));

  // 同一文档里可能有多个标注 SVG，filter id 必须唯一
  const fid = `sl-glow-${++filterSeq}`;
  const defs = el("defs", {}, svg);
  const glow = el("filter", { id: fid, x: "-20%", y: "-20%", width: "140%", height: "140%" }, defs);
  el("feDropShadow", { dx: 0, dy: 0, stdDeviation: 3 * k, "flood-color": "#000", "flood-opacity": 0.55 }, glow);

  const X = (v: number) => (v / 1000) * W;
  const Y = (v: number) => (v / 1000) * H;
  const sw = Math.max(1.5, 3.2 * k);
  const fontSize = Math.max(10, 15 * k);
  const labels: { x: number; y: number; text: string; color: string; anchorBelow: boolean }[] = [];
  // 已占用的区域（文字气泡、已放置的标签），后放的标签避让
  const placed: { x: number; y: number; w: number; h: number }[] = [];

  anns.forEach((a, i) => {
    const color = colorOf(a, i);
    const g = el("g", { filter: `url(#${fid})`, class: o.animate ? "sl-anim" : "" }, svg);
    if (o.animate) g.style.animationDelay = `${i * 140}ms`;
    const num = String(i + 1);
    const text = o.compact || !a.label ? num : `${num} ${a.label}`;

    if (a.type === "box" || a.type === "circle") {
      const [x1, y1, x2, y2] = a.bbox;
      const px = X(x1), py = Y(y1), pw = Math.max(4, X(x2) - X(x1)), ph = Math.max(4, Y(y2) - Y(y1));
      if (a.type === "box") {
        el("rect", { x: px, y: py, width: pw, height: ph, rx: 6 * k, fill: color, "fill-opacity": 0.08 }, g);
        const r = el("rect", { x: px, y: py, width: pw, height: ph, rx: 6 * k, fill: "none", stroke: color, "stroke-width": sw }, g);
        if (o.animate) dash(r, 2 * (pw + ph));
      } else {
        // 圈：外扩一点，像手画的椭圆
        const cx = px + pw / 2, cy = py + ph / 2;
        const rx = pw / 2 + 6 * k, ry = ph / 2 + 6 * k;
        el("ellipse", { cx, cy, rx, ry, fill: color, "fill-opacity": 0.06 }, g);
        const e = el("ellipse", { cx, cy, rx, ry, fill: "none", stroke: color, "stroke-width": sw * 1.1 }, g);
        if (o.animate) dash(e, Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))));
      }
      const below = py < fontSize * 2.2;
      labels.push({ x: px, y: below ? py + ph + 6 * k : py - 6 * k, text, color, anchorBelow: below });
    } else if (a.type === "text") {
      const b = bubbleLayout(a.at, a.label ?? "", W, H, k);
      const bg = "#16181d";
      if (a.to) {
        const [tx, ty] = [X(a.to[0]), Y(a.to[1])];
        const tail = bubbleTail(b, tx, ty, k);
        if (tail) {
          // 引线从气泡边缘到目标点，目标处画实心圆点
          const sx = (tail.base1[0] + tail.base2[0]) / 2, sy = (tail.base1[1] + tail.base2[1]) / 2;
          const line = el("path", { d: `M${sx},${sy} L${tx},${ty}`, stroke: color, "stroke-width": sw * 0.8, "stroke-linecap": "round", fill: "none" }, g);
          if (o.animate) dash(line, Math.hypot(tx - sx, ty - sy));
          el("circle", { cx: tx, cy: ty, r: 4.5 * k, fill: color }, g);
          if (o.animate) el("circle", { cx: tx, cy: ty, r: 6 * k, fill: "none", stroke: color, "stroke-width": 2 * k, class: "sl-pulse" }, g);
        }
      }
      el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 9 * k, fill: bg, "fill-opacity": 0.94, stroke: color, "stroke-width": sw * 0.7 }, g);
      // 编号徽章
      const r = b.badge / 2;
      const bcx = b.x + b.padX + r, bcy = b.y + b.padY + Math.max(r, b.lineH / 2);
      el("circle", { cx: bcx, cy: bcy, r, fill: color }, g);
      const nt = el("text", { x: bcx, y: bcy + b.fs * 0.33, "font-size": b.fs * 0.82, "font-weight": 700, "text-anchor": "middle", fill: isLight(color) ? "#111" : "#fff", "font-family": FONT }, g);
      nt.textContent = num;
      const tx0 = b.x + b.padX + b.badge + 7 * k;
      b.lines.forEach((line, li) => {
        const t = el("text", { x: tx0, y: b.y + b.padY + li * b.lineH + b.lineH / 2 + b.fs * 0.36, "font-size": b.fs, "font-weight": 500, fill: "#f5f6f8", "font-family": FONT }, g);
        t.textContent = line;
      });
      placed.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    } else {
      const [fx, fy] = [X(a.from[0]), Y(a.from[1])];
      const [tx, ty] = [X(a.to[0]), Y(a.to[1])];
      const ang = Math.atan2(ty - fy, tx - fx);
      const head = 16 * k;
      // 箭身停在箭头底部，避免线头戳出
      const bx = tx - Math.cos(ang) * head * 0.8;
      const by = ty - Math.sin(ang) * head * 0.8;
      // 轻微弧度
      const mx = (fx + bx) / 2, my = (fy + by) / 2;
      const len = Math.hypot(bx - fx, by - fy);
      const bend = Math.min(40 * k, len * 0.12);
      const cx = mx - Math.sin(ang) * bend, cy = my + Math.cos(ang) * bend;
      const p = el("path", { d: `M${fx},${fy} Q${cx},${cy} ${bx},${by}`, fill: "none", stroke: color, "stroke-width": sw * 1.15, "stroke-linecap": "round" }, g);
      if (o.animate) dash(p, len * 1.15);
      const a1 = ang + Math.PI * 0.85, a2 = ang - Math.PI * 0.85;
      const hp = el(
        "path",
        {
          d: `M${tx},${ty} L${tx + Math.cos(a1) * head},${ty + Math.sin(a1) * head} L${tx + Math.cos(a2) * head},${ty + Math.sin(a2) * head} Z`,
          fill: color,
        },
        g,
      );
      if (o.animate) hp.style.animation = "sl-pop .25s ease-out both .35s";
      // 目标点脉冲
      if (o.animate) el("circle", { cx: tx, cy: ty, r: 6 * k, fill: "none", stroke: color, "stroke-width": 2 * k, class: "sl-pulse" }, g);
      const below = fy > ty;
      labels.push({ x: fx - 10 * k, y: below ? fy + 8 * k : fy - 8 * k, text, color, anchorBelow: below });
    }
  });

  // 标签最后画，保证在最上层；与已放置标签重叠时下移避让
  labels.forEach((l, i) => {
    const g = el("g", { class: o.animate ? "sl-anim-label" : "" }, svg);
    if (o.animate) g.style.animationDelay = `${i * 140 + 250}ms`;
    const padX = 7 * k, h = fontSize + 8 * k;
    const t = el("text", { x: 0, y: 0, "font-size": fontSize, "font-weight": 600, fill: "#fff", "font-family": "Inter, 'Microsoft YaHei UI', sans-serif" }, g);
    t.textContent = l.text;
    let w = 0;
    try {
      // 粗体中文的实测宽度常偏窄，与估算值取较大者
      w = Math.max(t.getComputedTextLength(), estimateWidth(l.text, fontSize)) + padX * 2;
    } catch {
      /* 未挂载到可见 DOM 时可能失败 */
    }
    if (!w || !isFinite(w) || w <= padX * 2) w = estimateWidth(l.text, fontSize) + padX * 2;
    const x = Math.max(2, Math.min(W - w - 2, l.x));
    let y = l.anchorBelow ? l.y : l.y - h;
    y = Math.max(2, Math.min(H - h - 2, y));
    for (let n = 0; n < 8; n++) {
      const hit = placed.find((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y);
      if (!hit) break;
      y = Math.min(H - h - 2, hit.y + hit.h + 3);
    }
    placed.push({ x, y, w, h });
    const bg = el("rect", { x, y, width: w, height: h, rx: h / 2, fill: l.color, filter: `url(#${fid})` });
    g.insertBefore(bg, t);
    t.setAttribute("x", String(x + padX));
    t.setAttribute("y", String(y + h / 2 + fontSize * 0.36));
    if (isLight(l.color)) t.setAttribute("fill", "#111");
  });
}

function dash(e: SVGElement, len: number) {
  e.setAttribute("stroke-dasharray", String(len));
  e.setAttribute("stroke-dashoffset", String(len));
  e.style.animation = "sl-draw .55s cubic-bezier(.6,.1,.3,1) forwards";
}

function isLight(c: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

export const ANNOTATION_CSS = `
@keyframes sl-draw { to { stroke-dashoffset: 0; } }
@keyframes sl-pop { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: none; } }
@keyframes sl-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes sl-pulse-k { 0% { r: 4; opacity: .9; } 100% { r: 26; opacity: 0; } }
.sl-anim { animation: sl-fade .2s ease-out both; }
.sl-anim path, .sl-anim ellipse { transform-box: fill-box; transform-origin: center; }
.sl-anim-label { animation: sl-pop .25s ease-out both; transform-box: fill-box; transform-origin: left center; }
.sl-pulse { animation: sl-pulse-k 1.3s ease-out infinite; animation-delay: .6s; }
`;

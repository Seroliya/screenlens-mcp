import type { Annotation, Point } from "./types";
import { GH, GW } from "./frame-diff";

/**
 * 标注的纯几何布局（不依赖 DOM）：绘制层用它摆放文字气泡，
 * 观察模式用它算出标注占据的网格格子，在比较画面时忽略这些格子。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 中日韩字符按 1 个字宽，其余按 0.58 */
export function estimateWidth(s: string, fs: number) {
  let w = 0;
  for (const ch of s) w += /[\u2e80-\uffff]/.test(ch) ? fs : fs * 0.58;
  return w;
}

const MAX_LINES = 8;

/** 按宽度折行：中日韩逐字可断，英文按词断（超长单词再逐字断） */
export function wrapText(text: string, maxW: number, fs: number): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    let lw = 0;
    const tokens = para.match(/[\u2e80-\uffff]|[^\s\u2e80-\uffff]+|\s+/g) ?? [""];
    for (const tok of tokens) {
      const tw = estimateWidth(tok, fs);
      if (lw + tw <= maxW || !line.trim()) {
        if (tw > maxW && !/\s/.test(tok)) {
          // 单个超长单词：逐字塞
          for (const ch of tok) {
            const cw = estimateWidth(ch, fs);
            if (lw + cw > maxW && line) {
              lines.push(line);
              line = "";
              lw = 0;
            }
            line += ch;
            lw += cw;
          }
        } else {
          line += tok;
          lw += tw;
        }
        continue;
      }
      lines.push(line.trimEnd());
      line = /\s/.test(tok) ? "" : tok;
      lw = /\s/.test(tok) ? 0 : tw;
    }
    lines.push(line.trimEnd());
  }
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines[MAX_LINES - 1] = lines[MAX_LINES - 1].replace(/.$/, "") + "…";
  }
  return lines;
}

export interface BubbleLayout extends Rect {
  lines: string[];
  fs: number;
  lineH: number;
  padX: number;
  padY: number;
  badge: number;
}

/** 文字气泡的位置与尺寸（像素）。at 为气泡中心，超出画面时向内收。 */
export function bubbleLayout(at: Point, text: string, W: number, H: number, k = 1): BubbleLayout {
  const fs = Math.max(10, 15 * k);
  const lineH = fs * 1.45;
  const padX = 11 * k, padY = 8 * k;
  const badge = fs * 1.35;
  const maxText = Math.max(fs * 6, Math.min(W * 0.36, fs * 24));
  const lines = wrapText(text || " ", maxText, fs);
  const textW = Math.max(...lines.map((l) => estimateWidth(l, fs)));
  const w = Math.min(W - 8, textW + badge + 7 * k + padX * 2);
  const h = Math.max(badge + padY * 2, lines.length * lineH + padY * 2);
  const cx = (at[0] / 1000) * W, cy = (at[1] / 1000) * H;
  const x = Math.max(4, Math.min(W - w - 4, cx - w / 2));
  const y = Math.max(4, Math.min(H - h - 4, cy - h / 2));
  return { x, y, w, h, lines, fs, lineH, padX, padY, badge };
}

/** 气泡尾巴：从矩形边上离目标最近的点出发；目标在气泡内则无尾巴 */
export function bubbleTail(b: Rect, tx: number, ty: number, k = 1): { base1: Point; base2: Point } | null {
  const nx = Math.max(b.x, Math.min(b.x + b.w, tx));
  const ny = Math.max(b.y, Math.min(b.y + b.h, ty));
  if (nx === tx && ny === ty) return null;
  const half = 8 * k;
  // 尾巴根部放在边上，并向内收一点，避开圆角
  const inset = Math.min(14 * k, b.w / 2, b.h / 2);
  const onVertical = nx === b.x || nx === b.x + b.w;
  if (onVertical && (ny > b.y && ny < b.y + b.h)) {
    const y = Math.max(b.y + inset, Math.min(b.y + b.h - inset, ny));
    return { base1: [nx, y - half], base2: [nx, y + half] };
  }
  const x = Math.max(b.x + inset, Math.min(b.x + b.w - inset, nx));
  return { base1: [x - half, ny], base2: [x + half, ny] };
}

/**
 * 标注在 W×H 画面上占据的像素区域（偏保守：含描边、编号标签、动画脉冲）。
 * 坐标为该画面的 0~1000 归一化坐标。
 */
export function annotationRects(anns: Annotation[], W: number, H: number): Rect[] {
  const X = (v: number) => (v / 1000) * W;
  const Y = (v: number) => (v / 1000) * H;
  const fs = 15;
  const out: Rect[] = [];
  const pad = (x1: number, y1: number, x2: number, y2: number, p: number) =>
    out.push({ x: Math.min(x1, x2) - p, y: Math.min(y1, y2) - p, w: Math.abs(x2 - x1) + 2 * p, h: Math.abs(y2 - y1) + 2 * p });
  const label = (x: number, y: number, a: Annotation, i: number) => {
    const text = a.label ? `${i + 1} ${a.label}` : String(i + 1);
    const w = estimateWidth(text, fs) + 24;
    // 标签可能在锚点上方或下方，碰撞时还会下移，两边都算上
    out.push({ x: x - 12, y: y - 40, w: w + 12, h: 80 });
  };
  anns.forEach((a, i) => {
    if (a.type === "box" || a.type === "circle") {
      const [x1, y1, x2, y2] = a.bbox;
      pad(X(x1), Y(y1), X(x2), Y(y2), 12);
      label(X(x1), a.type === "box" ? Y(y1) : Y(y1) - 6, a, i);
      label(X(x1), Y(y2), a, i);
    } else if (a.type === "arrow") {
      const [fx, fy] = [X(a.from[0]), Y(a.from[1])];
      const [tx, ty] = [X(a.to[0]), Y(a.to[1])];
      const n = Math.max(2, Math.ceil(Math.hypot(tx - fx, ty - fy) / 20));
      for (let s = 0; s <= n; s++) {
        const x = fx + ((tx - fx) * s) / n, y = fy + ((ty - fy) * s) / n;
        pad(x, y, x, y, 46); // 箭身有弧度
      }
      pad(tx, ty, tx, ty, 30); // 目标点脉冲
      label(fx, fy, a, i);
    } else {
      const b = bubbleLayout(a.at, a.label ?? "", W, H);
      pad(b.x, b.y, b.x + b.w, b.y + b.h, 8);
      if (a.to) {
        const [tx, ty] = [X(a.to[0]), Y(a.to[1])];
        const n = Math.max(2, Math.ceil(Math.hypot(tx - b.x - b.w / 2, ty - b.y - b.h / 2) / 20));
        for (let s = 0; s <= n; s++) {
          const x = b.x + b.w / 2 + ((tx - b.x - b.w / 2) * s) / n;
          const y = b.y + b.h / 2 + ((ty - b.y - b.h / 2) * s) / n;
          pad(x, y, x, y, 14);
        }
        pad(tx, ty, tx, ty, 30);
      }
    }
  });
  return out;
}

/** 标注覆盖的 16×10 网格格子：1 = 比较画面时忽略 */
export function annotationMask(anns: Annotation[], W: number, H: number): Uint8Array {
  const m = new Uint8Array(GW * GH);
  for (const r of annotationRects(anns, W, H)) {
    const gx1 = Math.max(0, Math.floor((r.x / W) * GW));
    const gy1 = Math.max(0, Math.floor((r.y / H) * GH));
    const gx2 = Math.min(GW - 1, Math.floor(((r.x + r.w) / W) * GW));
    const gy2 = Math.min(GH - 1, Math.floor(((r.y + r.h) / H) * GH));
    for (let gy = gy1; gy <= gy2; gy++) for (let gx = gx1; gx <= gx2; gx++) m[gy * GW + gx] = 1;
  }
  return m;
}

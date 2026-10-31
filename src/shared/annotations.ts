import type { Annotation, BBox, Point } from "./types";

/**
 * 模型在回复末尾输出：
 * ```annotations
 * [{"type":"box","bbox":[x1,y1,x2,y2],"label":"..."}]
 * ```
 * 这里负责：1) 从文本中剥离该代码块（含流式未闭合的情况）；2) 宽松解析 JSON。
 */

const FENCE_RE = /```\s*(annotations|annotation|annot)\s*\n([\s\S]*?)(```|$)/i;

export interface SplitResult {
  text: string;
  annotations: Annotation[];
  /** 代码块尚未闭合（流式中） */
  pending: boolean;
}

export function splitAnnotations(raw: string): SplitResult {
  const m = FENCE_RE.exec(raw);
  if (!m) return { text: raw, annotations: [], pending: false };
  const closed = m[3] === "```";
  const text = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trimEnd();
  if (!closed) return { text, annotations: [], pending: true };
  return { text, annotations: parseAnnotations(m[2]), pending: false };
}

const clamp = (v: number) => Math.max(0, Math.min(1000, v));
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN);

function toPoint(v: unknown): Point | null {
  if (Array.isArray(v) && v.length >= 2) {
    const x = num(v[0]), y = num(v[1]);
    if (isFinite(x) && isFinite(y)) return [clamp(x), clamp(y)];
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const x = num(o.x), y = num(o.y);
    if (isFinite(x) && isFinite(y)) return [clamp(x), clamp(y)];
  }
  return null;
}

function toBBox(o: Record<string, unknown>): BBox | null {
  const b = o.bbox ?? o.box ?? o.bbox_2d ?? o.rect;
  if (Array.isArray(b) && b.length >= 4) {
    const v = b.slice(0, 4).map(num);
    if (v.every(isFinite)) {
      const [x1, y1, x2, y2] = v;
      return [clamp(Math.min(x1, x2)), clamp(Math.min(y1, y2)), clamp(Math.max(x1, x2)), clamp(Math.max(y1, y2))];
    }
  }
  // 圆心 + 半径
  const c = toPoint(o.center ?? o.c);
  const r = num(o.r ?? o.radius);
  if (c && isFinite(r)) return [clamp(c[0] - r), clamp(c[1] - r), clamp(c[0] + r), clamp(c[1] + r)];
  // x,y,w,h
  const x = num(o.x), y = num(o.y), w = num(o.w ?? o.width), h = num(o.h ?? o.height);
  if ([x, y, w, h].every(isFinite)) return [clamp(x), clamp(y), clamp(x + w), clamp(y + h)];
  return null;
}

export function parseAnnotations(src: string): Annotation[] {
  let data: unknown;
  try {
    data = JSON.parse(src.trim());
  } catch {
    // 容错：截取第一个 [ 到最后一个 ]，并去掉尾逗号
    const s = src.indexOf("["), e = src.lastIndexOf("]");
    if (s < 0 || e <= s) return [];
    try {
      data = JSON.parse(src.slice(s, e + 1).replace(/,\s*([\]}])/g, "$1"));
    } catch {
      return [];
    }
  }
  if (data && !Array.isArray(data) && typeof data === "object") {
    const o = data as Record<string, unknown>;
    data = o.annotations ?? o.items ?? [o];
  }
  if (!Array.isArray(data)) return [];

  const out: Annotation[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const type = String(o.type ?? o.shape ?? "box").toLowerCase();
    const rawLabel = typeof o.label === "string" ? o.label : typeof o.text === "string" ? o.text : undefined;
    if (["text", "note", "bubble", "callout", "tooltip", "comment"].includes(type)) {
      // 气泡正文优先取 text，label 作为备选；不剥编号前缀（正文里的 "1." 可能是内容）
      const body = (typeof o.text === "string" ? o.text : typeof o.label === "string" ? o.label : "").trim();
      const bb = toBBox(o);
      const at = toPoint(o.at ?? o.position ?? o.pos ?? o.center ?? o.point) ?? (bb ? ([(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] as Point) : null);
      if (!body || !at) continue;
      const to = toPoint(o.to ?? o.target ?? o.pointer);
      out.push({
        type: "text",
        at,
        ...(to ? { to } : {}),
        label: body,
        color: typeof o.color === "string" ? o.color : undefined,
        image: isFinite(num(o.image)) ? num(o.image) : undefined,
      });
      continue;
    }
    const extra = {
      // 编号由绘制层自动加，去掉模型自带的 ①/1./(1) 前缀
      label: rawLabel?.replace(/^\s*(?:[①-⑳❶-❿]|\(?\d{1,2}[.、:：)）])\s*/, "") || undefined,
      color: typeof o.color === "string" ? o.color : undefined,
      image: isFinite(num(o.image)) ? num(o.image) : undefined,
    };
    if (type.startsWith("arrow") || type === "pointer" || type === "line") {
      const from = toPoint(o.from ?? o.start ?? o.tail);
      const to = toPoint(o.to ?? o.end ?? o.head ?? o.point);
      if (to) out.push({ type: "arrow", from: from ?? autoTail(to), to, ...extra });
    } else if (type === "point" || type === "dot") {
      const p = toPoint(o.point ?? o.at ?? o.center ?? [o.x, o.y]);
      if (p) out.push({ type: "arrow", from: autoTail(p), to: p, ...extra });
    } else {
      const bbox = toBBox(o);
      if (!bbox) continue;
      const shape = type.startsWith("circ") || type.startsWith("ellip") || type === "ring" ? "circle" : "box";
      out.push({ type: shape, bbox, ...extra });
    }
  }
  return out;
}

/** 只给了箭头终点时，自动从左下/右下方向引出一条箭身 */
function autoTail(to: Point): Point {
  const dx = to[0] > 500 ? -110 : 110;
  const dy = to[1] > 300 ? -110 : 110;
  return [clamp(to[0] + dx), clamp(to[1] + dy)];
}

export const PALETTE = ["#ff3b5c", "#ffb020", "#22d3ee", "#a3e635", "#c084fc", "#fb7185", "#38bdf8"];

export function colorOf(a: Annotation, i: number): string {
  const named: Record<string, string> = {
    red: "#ff3b5c", orange: "#ff8a1f", yellow: "#ffd60a", green: "#34d399",
    blue: "#3b82f6", cyan: "#22d3ee", purple: "#c084fc", pink: "#f472b6", white: "#ffffff",
  };
  if (a.color) return named[a.color.toLowerCase()] ?? a.color;
  return PALETTE[i % PALETTE.length];
}

export const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

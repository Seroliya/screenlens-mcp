/**
 * 观察模式的画面比较（纯函数，可单测）。
 * 帧 = 160×100 的灰度缩略图；按 16×10 网格（每格 10×10 像素）比较，
 * 统计\"变了的格子\"的占比，零星变化（光标、时钟跳秒）因此天然被忽略。
 */
export const TW = 160;
export const TH = 100;
export const GW = 16;
export const GH = 10;
const CW = TW / GW;
const CH = TH / GH;

/** 一格内平均灰度差超过它才算这格变了（0~255） */
export const CELL_THRESHOLD = 6;

export interface DiffResult {
  /** 变化格子占比 0~1 */
  ratio: number;
  cells: number;
  /** 变化区域外接框，0~1000 归一化；无变化为 null */
  bbox: [number, number, number, number] | null;
}

/** BGRA（Electron NativeImage.toBitmap 在 Windows 上的格式）→ 灰度 */
export function lumaFromBGRA(buf: Uint8Array, w = TW, h = TH): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (buf[p] * 29 + buf[p + 1] * 150 + buf[p + 2] * 77) >> 8;
  }
  return out;
}

/** 两个忽略掩码取并集；都为空返回 null */
export function unionMask(a: Uint8Array | null, b: Uint8Array | null): Uint8Array | null {
  if (!a) return b;
  if (!b) return a;
  const m = new Uint8Array(GW * GH);
  for (let i = 0; i < m.length; i++) m[i] = a[i] | b[i];
  return m;
}

/** ignore：GW×GH 掩码，1 的格子不参与比较（如屏幕上正显示的标注） */
export function diffFrames(a: Uint8Array, b: Uint8Array, threshold = CELL_THRESHOLD, ignore: Uint8Array | null = null): DiffResult {
  let cells = 0;
  let x1 = GW, y1 = GH, x2 = -1, y2 = -1;
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      if (ignore?.[gy * GW + gx]) continue;
      let sum = 0;
      for (let y = gy * CH; y < (gy + 1) * CH; y++) {
        const row = y * TW;
        for (let x = gx * CW; x < (gx + 1) * CW; x++) sum += Math.abs(a[row + x] - b[row + x]);
      }
      if (sum / (CW * CH) > threshold) {
        cells++;
        if (gx < x1) x1 = gx;
        if (gy < y1) y1 = gy;
        if (gx > x2) x2 = gx;
        if (gy > y2) y2 = gy;
      }
    }
  }
  return {
    ratio: cells / (GW * GH),
    cells,
    bbox: cells ? [(x1 * 1000) / GW, (y1 * 1000) / GH, ((x2 + 1) * 1000) / GW, ((y2 + 1) * 1000) / GH] : null,
  };
}

/** 进程名列表匹配（逗号/空格分隔，忽略大小写与 .exe） */
export function parseProcList(s: string): string[] {
  return s
    .split(/[,，\s]+/)
    .map((x) => x.trim().toLowerCase().replace(/\.exe$/, ""))
    .filter(Boolean);
}
export const procIn = (proc: string, list: string[]) => list.includes(proc.toLowerCase().replace(/\.exe$/, ""));

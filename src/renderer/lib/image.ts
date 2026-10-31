/**
 * 发给模型前的图片预处理：缩放到 maxSide，并叠加 0~1000 归一化坐标网格。
 * 库里存的永远是干净原图；网格只出现在发给模型的副本上。
 */

export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
}

const cache = new Map<string, PreparedImage>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

export async function prepareImage(shotId: string, maxSide: number, grid: boolean): Promise<PreparedImage> {
  const key = `${shotId}|${maxSide}|${grid}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // 走 IPC 拿 data URL，避免自定义协议导致 canvas 被污染
  const img = await loadImage(await window.api.shotDataUrl(shotId));
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * s);
  const H = Math.round(img.naturalHeight * s);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, W, H);
  if (grid) drawGrid(ctx, W, H);

  const out = { dataUrl: canvas.toDataURL("image/jpeg", 0.85), width: W, height: H };
  cache.set(key, out);
  if (cache.size > 30) cache.delete(cache.keys().next().value!);
  return out;
}

/** 每 50 一条线（100 的整数倍为实线并标数字），颜色用橙色，深浅背景都看得见。 */
export function drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const fs = Math.max(10, Math.round(Math.min(W, H) / 70));
  ctx.save();
  for (let i = 1; i < 20; i++) {
    const major = i % 2 === 0;
    ctx.strokeStyle = major ? "rgba(255,140,0,0.55)" : "rgba(255,140,0,0.22)";
    ctx.lineWidth = major ? 1.2 : 1;
    ctx.setLineDash(major ? [] : [4, 4]);
    const x = Math.round((i / 20) * W) + 0.5;
    const y = Math.round((i / 20) * H) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = `bold ${fs}px Consolas, monospace`;
  ctx.textBaseline = "top";
  const tag = (text: string, x: number, y: number) => {
    const w = ctx.measureText(text).width + 6;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x, y, w, fs + 4);
    ctx.fillStyle = "rgba(255,190,90,0.95)";
    ctx.fillText(text, x + 3, y + 2);
  };
  for (let v = 100; v < 1000; v += 100) {
    const x = (v / 1000) * W;
    const y = (v / 1000) * H;
    const label = String(v);
    const tw = ctx.measureText(label).width + 6;
    tag(label, x - tw / 2, 2); // 顶边：x 坐标
    tag(label, 2, y - (fs + 4) / 2); // 左边：y 坐标
  }
  ctx.restore();
}

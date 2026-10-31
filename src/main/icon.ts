import { nativeImage } from "electron";

/** 程序化生成托盘/窗口图标（避免二进制资源）：渐变圆环 + 中心点，像一只"镜头"。 */
export function makeIcon(size = 32) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / (size / 2);
      const i = (y * size + x) * 4;
      let a = 0;
      let r = 0, g = 0, b = 0;
      const t = x / size;
      const ring = d > 0.62 && d < 0.95;
      const dot = d < 0.3;
      if (ring || dot) {
        a = 255;
        r = Math.round(255 * (1 - t) + 34 * t);
        g = Math.round(59 * (1 - t) + 211 * t);
        b = Math.round(92 * (1 - t) + 238 * t);
        const edge = ring ? Math.min(d - 0.62, 0.95 - d) : 0.3 - d;
        a = Math.round(255 * Math.min(1, edge * size * 0.9));
      }
      // BGRA
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

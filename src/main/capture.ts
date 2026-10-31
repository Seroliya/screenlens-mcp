import { desktopCapturer, nativeImage, screen, type Display, type NativeImage } from "electron";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DisplayInfo, ShotRef, SourceKind } from "../shared/types";
import { shotPath } from "./store";

export function listDisplays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `显示器 ${i + 1}`,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    primary: d.id === primary,
  }));
}

export function resolveDisplay(target: "cursor" | number | undefined): Display {
  if (typeof target === "number") {
    const d = screen.getAllDisplays().find((x) => x.id === target);
    if (d) return d;
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/** 截取整个显示器（物理分辨率），保存为 JPEG。 */
export async function captureDisplay(display: Display): Promise<ShotRef> {
  const w = Math.round(display.size.width * display.scaleFactor);
  const h = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: w, height: h } });
  const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
  if (!src) throw new Error(`找不到显示器 ${display.id} 的捕获源`);
  const img = src.thumbnail;
  if (img.isEmpty()) throw new Error("截屏结果为空（可能缺少屏幕录制权限）");
  const size = img.getSize();
  const id = randomUUID();
  fs.writeFileSync(shotPath(id), img.toJPEG(90));
  const idx = screen.getAllDisplays().findIndex((d) => d.id === display.id);
  return {
    id,
    source: "screen",
    width: size.width,
    height: size.height,
    displayId: display.id,
    label: `屏幕 ${idx + 1}`,
    createdAt: Date.now(),
  };
}

/** 保存渲染进程传来的图片（摄像头帧 / 上传 / 粘贴），统一存为 JPEG。 */
export function saveDataUrlShot(dataUrl: string, source: SourceKind, label?: string, width = 0, height = 0): ShotRef {
  const m = /^data:image\/(png|jpe?g|webp|gif|bmp);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("不支持的图片格式");
  const id = randomUUID();
  const raw = Buffer.from(m[2], "base64");
  const isJpeg = m[1] === "jpeg" || m[1] === "jpg";
  let out: Buffer = raw;
  if (!isJpeg || !width || !height) {
    const ni = nativeImage.createFromBuffer(raw);
    if (ni.isEmpty()) throw new Error("无法解码图片（webp/gif 请先转成 png/jpg）");
    const s = ni.getSize();
    width = width || s.width;
    height = height || s.height;
    if (!isJpeg) out = ni.toJPEG(90);
  }
  fs.writeFileSync(shotPath(id), out);
  return { id, source, width, height, label, createdAt: Date.now() };
}

// ---------------------------------------------------------------- 观察模式用
export interface WindowInfo {
  id: string;
  name: string;
  thumb: string;
  icon?: string;
}

/** 列出可锁定的窗口（带小缩略图），排除本应用自己的窗口 */
export async function listWindows(): Promise<WindowInfo[]> {
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true });
  return sources
    .filter((s) => s.name && s.name !== "ScreenLens" && !s.thumbnail.isEmpty())
    .map((s) => ({
      id: s.id,
      name: s.name,
      thumb: "data:image/jpeg;base64," + s.thumbnail.toJPEG(70).toString("base64"),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined,
    }));
}

export const hwndOf = (sourceId: string) => /^window:(\d+):/.exec(sourceId)?.[1] ?? null;

/** 观察用缩略图：屏幕按 display、窗口按 source id；找不到返回 null */
export async function grabThumb(kind: "screen" | "window", target: string): Promise<NativeImage | null> {
  const sources = await desktopCapturer.getSources({ types: [kind], thumbnailSize: { width: 320, height: 200 } });
  const src = kind === "screen" ? sources.find((s) => s.display_id === target) ?? (sources.length === 1 ? sources[0] : undefined) : sources.find((s) => s.id === target);
  if (!src || src.thumbnail.isEmpty()) return null;
  return src.thumbnail;
}

/** 截取一个窗口（即使在其它窗口后面；最小化时会失败）。physW/H 为窗口物理尺寸 */
export async function captureWindow(sourceId: string, label: string, physW: number, physH: number): Promise<ShotRef> {
  const w = Math.max(320, Math.min(3840, physW || 1920));
  const h = Math.max(200, Math.min(2400, physH || 1200));
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: w, height: h } });
  const src = sources.find((s) => s.id === sourceId);
  if (!src || src.thumbnail.isEmpty()) throw new Error("目标窗口不可截取（已关闭或最小化）");
  const img = src.thumbnail;
  const size = img.getSize();
  const id = randomUUID();
  fs.writeFileSync(shotPath(id), img.toJPEG(90));
  return { id, source: "window", width: size.width, height: size.height, label, createdAt: Date.now() };
}

export function deleteShot(id: string) {
  for (const f of [shotPath(id), shotPath(id).replace(/\.jpg$/, ".json")]) fs.rmSync(f, { force: true });
}

export function readShotDataUrl(id: string): string {
  return "data:image/jpeg;base64," + fs.readFileSync(shotPath(id)).toString("base64");
}

import { BrowserWindow, globalShortcut, screen } from "electron";
import * as path from "node:path";
import type { Annotation } from "../shared/types";
import { getSettings } from "./store";

/** 不隐藏覆盖层、不闪烁，直接改变 Windows 的捕获保护。 */
export function updateOverlayCaptureProtection() {
  const protect = !getSettings().recordAnnotations && !process.env.SCREENLENS_OVERLAY_IN_CAPTURE;
  for (const w of overlays.values()) if (!w.isDestroyed()) w.setContentProtection(protect);
}

/**
 * 录屏模式下标注也会进入截屏。返回当前可见的标注（显示器 0~1000 坐标），
 * 自动观察据此忽略标注所在区域，避免标注触发自身，同时不必等用户按 Esc。
 */
export function recordableOverlay(): { displayId: number; annotations: Annotation[] } | null {
  if (!current) return null;
  if (!getSettings().recordAnnotations && !process.env.SCREENLENS_OVERLAY_IN_CAPTURE) return null;
  const w = overlays.get(current.displayId);
  return w && !w.isDestroyed() && w.isVisible() ? current : null;
}

/**
 * 每个显示器一个透明、置顶、点击穿透的覆盖层窗口。
 * 截图覆盖整块显示器，因此归一化坐标(0~1000) 直接映射到覆盖层窗口的 CSS 尺寸。
 */
const overlays = new Map<number, BrowserWindow>();
let hideTimer: NodeJS.Timeout | null = null;
let escRegistered = false;
let onCleared: (() => void) | null = null;
let current: { displayId: number; annotations: Annotation[] } | null = null;

export function setOverlayClearedListener(fn: () => void) {
  onCleared = fn;
}

async function getOverlay(displayId: number): Promise<BrowserWindow | null> {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (!display) return null;
  let win = overlays.get(displayId);
  if (win && !win.isDestroyed()) {
    win.setBounds(display.bounds);
    return win;
  }
  win = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  // 默认允许录屏捕获标注；可在设置中单独关闭，不影响主聊天窗口的隐藏策略。
  win.setContentProtection(!getSettings().recordAnnotations && !process.env.SCREENLENS_OVERLAY_IN_CAPTURE);
  // 不同 DPI 的副屏上，构造参数里的 bounds 可能被缩放，创建后再校正一次
  win.setBounds(display.bounds);
  await win.loadFile(path.join(__dirname, "overlay", "overlay.html"));
  overlays.set(displayId, win);
  return win;
}

export async function showAnnotations(displayId: number, annotations: Annotation[], seconds: number) {
  clearAnnotations(false);
  const win = await getOverlay(displayId);
  if (!win) throw new Error("目标显示器已不存在");
  current = { displayId, annotations };
  win.webContents.send("overlay:draw", annotations);
  win.showInactive();
  win.moveTop();
  if (!escRegistered) {
    escRegistered = globalShortcut.register("Escape", () => clearAnnotations());
  }
  if (seconds > 0) hideTimer = setTimeout(() => clearAnnotations(), seconds * 1000);
}

export function clearAnnotations(notify = true) {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  current = null;
  if (escRegistered) {
    globalShortcut.unregister("Escape");
    escRegistered = false;
  }
  let had = false;
  for (const w of overlays.values()) {
    if (!w.isDestroyed() && w.isVisible()) {
      had = true;
      w.webContents.send("overlay:clear");
      w.hide();
    }
  }
  if (had && notify) onCleared?.();
}

export function destroyOverlays() {
  for (const w of overlays.values()) if (!w.isDestroyed()) w.destroy();
  overlays.clear();
}

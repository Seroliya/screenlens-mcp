import { BrowserWindow, dialog, Notification, screen } from "electron";
import { makeIcon } from "./icon";

/**
 * 外部 Agent（MCP）使用摄像头前必须由用户确认。
 * 在主进程桥接层强制执行：MCP 参数无法跳过，授权只保存在内存里（重启即失效），也没有\"不再询问\"的设置。
 */

const ASK_TIMEOUT_MS = 60_000;
const DENY_COOLDOWN_MS = 30_000;
export const GRANT_MINUTES = 10;

let grantUntil = 0;
let deniedAt = 0;
let pending: Promise<void> | null = null;
let onChange: ((s: CameraConsentState) => void) | null = null;

export interface CameraConsentState {
  /** 有效期内的授权截止时间（ms）；0 = 没有授权 */
  grantUntil: number;
}

export function setCameraConsentListener(fn: (s: CameraConsentState) => void) {
  onChange = fn;
}

export function cameraConsentState(): CameraConsentState {
  return { grantUntil: grantUntil > Date.now() ? grantUntil : 0 };
}

export function revokeCameraConsent() {
  const had = grantUntil > Date.now();
  grantUntil = 0;
  onChange?.(cameraConsentState());
  return had;
}

/** 通过则返回；用户拒绝/超时则抛错（错误信息会原样返回给 Agent） */
export async function ensureCameraConsent(reason: string): Promise<void> {
  if (grantUntil > Date.now()) return;
  if (Date.now() - deniedAt < DENY_COOLDOWN_MS) {
    throw new Error("用户刚刚拒绝了摄像头访问，请不要重复请求；如确有需要，先在对话中向用户说明原因并等待其同意后再试。");
  }
  // 同一时间只弹一个确认框，并发请求共用结果
  if (!pending) pending = ask(reason).finally(() => (pending = null));
  return pending;
}

async function ask(reason: string) {
  // 应用常在后台（托盘）运行：用一个置顶的小父窗口，保证确认框出现在最前面
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const parent = new BrowserWindow({
    width: 1, height: 1,
    x: Math.round(d.workArea.x + d.workArea.width / 2), y: Math.round(d.workArea.y + d.workArea.height / 2),
    frame: false, transparent: true, skipTaskbar: true, resizable: false, alwaysOnTop: true, show: false,
  });
  parent.setAlwaysOnTop(true, "screen-saver");
  parent.showInactive();
  parent.focus();

  if (Notification.isSupported()) {
    new Notification({ title: "ScreenLens：Agent 请求使用摄像头", body: reason || "外部 Agent 想拍一张摄像头画面", icon: makeIcon(64) }).show();
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ASK_TIMEOUT_MS);
  let choice = 0;
  try {
    const r = await dialog.showMessageBox(parent, {
      type: "question",
      title: "ScreenLens · 摄像头访问请求",
      message: "外部 Agent 请求使用你的摄像头拍摄一张画面",
      detail:
        (reason ? `用途：${reason}\n\n` : "") +
        `画面会发送给调用 ScreenLens MCP 的 AI。\n${ASK_TIMEOUT_MS / 1000} 秒内不选择将视为拒绝。`,
      buttons: ["拒绝", "仅这一次", `${GRANT_MINUTES} 分钟内允许`],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal: ac.signal,
    });
    choice = ac.signal.aborted ? 0 : r.response;
  } finally {
    clearTimeout(timer);
    parent.destroy();
  }

  if (choice === 2) {
    grantUntil = Date.now() + GRANT_MINUTES * 60_000;
    onChange?.(cameraConsentState());
    return;
  }
  if (choice === 1) return;
  deniedAt = Date.now();
  throw new Error(
    ac.signal.aborted
      ? "用户没有在 60 秒内确认摄像头访问，已视为拒绝。请不要重复请求。"
      : "用户拒绝了摄像头访问。请不要重复请求；如确有需要，先在对话中向用户说明原因。",
  );
}

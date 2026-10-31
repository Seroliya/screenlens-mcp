import { app, BrowserWindow, globalShortcut, ipcMain, Menu, protocol, screen, session, shell, Tray } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Annotation, Conversation, Settings, ShotRef, SourceKind } from "../shared/types";
import { parseAnnotations } from "../shared/annotations";
import * as store from "./store";
import { captureDisplay, listDisplays, readShotDataUrl, resolveDisplay, saveDataUrlShot } from "./capture";
import { clearAnnotations, destroyOverlays, setOverlayClearedListener, showAnnotations, updateOverlayCaptureProtection } from "./overlay";
import { abortChat, applyProxy, complete, listModels, streamChat } from "./llm";
import { startBridge, stopBridge } from "./bridge";
import { makeIcon } from "./icon";
import { installMcp, mcpStatus, type McpClient } from "./mcp-install";
import { mapToDisplay, Watcher } from "./watch";
import { stopAgentWatch, watchNext, type AgentWatchDeps, type AgentWatchParams } from "./agent-watch";
import { deleteShot, listWindows } from "./capture";
import { Notification } from "electron";
import { ensureCameraConsent, revokeCameraConsent, setCameraConsentListener } from "./camera-consent";
import type { WatchState } from "../shared/types";

// ---------------------------------------------------------------- 自动观察
const trayTooltip = (watching?: string) =>
  watching
    ? `${serviceMode ? "ScreenLens 服务" : "ScreenLens"} · 观察中（${watching}）`
    : serviceMode
      ? "ScreenLens 服务（MCP 后端）"
      : "ScreenLens";

let watcher: Watcher | null = null;
const idleWatchState = (): WatchState => ({
  running: false, scopeLabel: "", paused: null, ratio: 0, phase: "未开启", sent: 0, silent: 0, spoke: 0, lastSentAt: 0, hourCount: 0,
});

function startWatch() {
  watcher?.stop();
  const w = new Watcher(store.getSettings(), {
    registerShot: (s) => registerShot(s),
    onTrigger: (t) => win?.webContents.send("watch:trigger", t),
    onState: (s) => {
      win?.webContents.send("watch:state", s);
      tray?.setToolTip(s.running ? trayTooltip(s.scopeLabel) : trayTooltip());
    },
  });
  w.start();
  watcher = w;
  return w.state;
}

function stopWatch() {
  watcher?.stop();
  watcher = null;
  win?.webContents.send("watch:state", idleWatchState());
  return idleWatchState();
}

// MCP：外部 Agent 自己当观察者（watch_next 阻塞等待下一次值得看的变化）
const agentWatchDeps: AgentWatchDeps = {
  registerShot: (s) => registerShot(s),
  onState: (s) => win?.webContents.send("watch:agent-state", s),
  onStart: (label) => {
    win?.webContents.send("app:toast", { kind: "info", text: `外部 Agent 开始观察${label}` });
    tray?.setToolTip(trayTooltip(label));
  },
  onStop: () => {
    win?.webContents.send("watch:agent-state", null);
    win?.webContents.send("app:toast", { kind: "info", text: "外部 Agent 结束观察" });
    tray?.setToolTip(trayTooltip());
  },
};

function watchNotify(convId: string, text: string) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: "ScreenLens 观察提醒", body: text.slice(0, 180), icon: makeIcon(64), silent: false });
  n.on("click", () => {
    showWindow();
    win?.webContents.send("app:open-conv", convId);
  });
  n.show();
}

// 固定数据目录，MCP 桥接脚本依赖这个位置找到 bridge.json
app.setPath("userData", path.join(app.getPath("appData"), "ScreenLens"));
app.setAppUserModelId("ScreenLens");

const startHidden = process.argv.includes("--background");
/**
 * 服务模式（--service / --background）：作为 MCP 的纯后端运行，不展示任何 GUI。
 * 窗口永远隐藏（只当 canvas/摄像头 RPC 后端），不注册全局快捷键，
 * 托盘只保留：打开设置 / 撤销摄像头授权 / 退出。
 */
const serviceMode = startHidden || process.argv.includes("--service");

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "shot", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let lastShotId: string | null = null;

// ---------------------------------------------------------------- 截图元数据
const shotMetaPath = (id: string) => store.shotPath(id).replace(/\.jpg$/, ".json");
function registerShot(s: ShotRef) {
  fs.writeFileSync(shotMetaPath(s.id), JSON.stringify(s), "utf8");
  lastShotId = s.id;
  return s;
}
function getShot(id: string): ShotRef | null {
  try {
    return JSON.parse(fs.readFileSync(shotMetaPath(id), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 主进程 → 渲染进程 RPC（图片加网格、摄像头取帧等需要 canvas / getUserMedia）
let rpcSeq = 0;
const rpcPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
ipcMain.on("rpc:res", (_e, msg: { id: number; result?: unknown; error?: string }) => {
  const p = rpcPending.get(msg.id);
  if (!p) return;
  rpcPending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
});
async function rendererCall<T>(method: string, params: unknown, timeoutMs = 20000): Promise<T> {
  const w = await ensureWindow();
  const id = ++rpcSeq;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`渲染进程响应超时: ${method}`));
    }, timeoutMs);
    rpcPending.set(id, {
      resolve: (v) => (clearTimeout(t), resolve(v as T)),
      reject: (e) => (clearTimeout(t), reject(e)),
    });
    w.webContents.send("rpc:req", { id, method, params });
  });
}

// ---------------------------------------------------------------- 窗口
let windowReady: Promise<void> | null = null;

function createWindow(show: boolean) {
  const s = store.getSettings();
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1180, wa.width - 80);
  const height = Math.min(820, wa.height - 60);
  win = new BrowserWindow({
    width,
    height,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "ScreenLens",
    icon: makeIcon(64),
    backgroundColor: "#0d0f14",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: "#c9cfdb", height: 44 },
    alwaysOnTop: s.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setContentProtection(s.hideFromCapture);
  win.setMenu(null);
  windowReady = new Promise((resolve) => win!.webContents.once("did-finish-load", () => resolve()));
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => show && win?.show());
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file:")) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

async function ensureWindow(): Promise<BrowserWindow> {
  if (!win || win.isDestroyed()) createWindow(false);
  await windowReady;
  return win!;
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

// ---------------------------------------------------------------- 截屏
async function captureScreen(target?: "cursor" | number | "primary"): Promise<ShotRef> {
  const s = store.getSettings();
  const t = target === "primary" ? screen.getPrimaryDisplay().id : target ?? s.screenTarget;
  const display = resolveDisplay(t);
  // 未开启"截图中隐藏本应用"时，临时隐藏窗口
  const needHide = !s.hideFromCapture && win?.isVisible();
  if (needHide) {
    win!.hide();
    await new Promise((r) => setTimeout(r, 180));
  }
  try {
    return registerShot(await captureDisplay(display));
  } finally {
    if (needHide) win!.showInactive();
  }
}

async function hotkeyCapture() {
  try {
    const shot = await captureScreen("cursor");
    showWindow();
    win!.webContents.send("app:attach-shot", shot);
  } catch (e) {
    showWindow();
    win?.webContents.send("app:toast", { kind: "error", text: `截屏失败：${(e as Error).message}` });
  }
}

// ---------------------------------------------------------------- 标注投影
async function showShotAnnotations(shotId: string, annotations: Annotation[], seconds?: number, fromAgent = false) {
  const shot = getShot(shotId);
  if (!shot) throw new Error(`截图不存在: ${shotId}`);
  const secs = seconds ?? store.getSettings().overlaySeconds;
  if (shot.source === "screen" && shot.displayId != null) {
    await showAnnotations(shot.displayId, annotations, secs);
    win?.webContents.send("app:overlay-state", { active: true, shotId });
    return { target: "screen", displayId: shot.displayId };
  }
  if (shot.source === "window" && shot.screenRect && shot.displayId != null) {
    const d = screen.getAllDisplays().find((x) => x.id === shot.displayId);
    if (d) {
      await showAnnotations(d.id, mapToDisplay(annotations, shot.screenRect, d.bounds), secs);
      win?.webContents.send("app:overlay-state", { active: true, shotId });
      return { target: "screen", displayId: d.id };
    }
  }
  // 摄像头 / 上传图片：在应用内查看器上绘制
  if (fromAgent) {
    const w = await ensureWindow();
    if (!w.isVisible()) w.showInactive();
    w.webContents.send("app:show-annotated", { shot, annotations });
  }
  return { target: "inline" };
}

// ---------------------------------------------------------------- 快捷键
function registerHotkeys(s: Settings): string[] {
  globalShortcut.unregisterAll();
  const failed: string[] = [];
  const reg = (acc: string, fn: () => void) => {
    if (!acc) return;
    try {
      if (!globalShortcut.register(acc, fn)) failed.push(acc);
    } catch {
      failed.push(acc);
    }
  };
  reg(s.hotkeyCapture, hotkeyCapture);
  reg(s.hotkeyToggle, toggleWindow);
  return failed;
}

// ---------------------------------------------------------------- IPC
function setupIpc() {
  const h = <A extends unknown[], R>(ch: string, fn: (...a: A) => R | Promise<R>) =>
    ipcMain.handle(ch, (_e, ...a) => fn(...(a as A)));

  h("settings:get", () => store.getSettings());
  h("settings:set", async (patch: Partial<Settings>) => {
    const s = store.setSettings(patch);
    if ("proxy" in patch) await applyProxy(s.proxy);
    if ("hideFromCapture" in patch) win?.setContentProtection(s.hideFromCapture);
    if ("recordAnnotations" in patch) updateOverlayCaptureProtection();
    if ("alwaysOnTop" in patch) win?.setAlwaysOnTop(s.alwaysOnTop);
    const failed = "hotkeyCapture" in patch || "hotkeyToggle" in patch ? registerHotkeys(s) : [];
    return { settings: s, failedHotkeys: failed };
  });

  h("conv:list", () => store.listConversations());
  h("conv:get", (id: string) => store.getConversation(id));
  h("conv:save", (c: Conversation) => store.saveConversation(c));
  h("conv:delete", (id: string) => store.deleteConversation(id));

  h("displays:list", () => listDisplays());
  h("capture:screen", (target?: "cursor" | number) => captureScreen(target));
  h("capture:dataUrl", (dataUrl: string, source: SourceKind, label?: string, w?: number, hgt?: number) =>
    registerShot(saveDataUrlShot(dataUrl, source, label, w, hgt)),
  );
  h("shot:dataUrl", (id: string) => readShotDataUrl(id));

  h("overlay:show", (shotId: string, annotations: Annotation[]) => showShotAnnotations(shotId, annotations));
  h("overlay:clear", () => clearAnnotations());

  h("chat:start", (requestId: string, messages: unknown[]) => {
    const sender = win!.webContents;
    const s = store.getSettings();
    streamChat(s, requestId, messages, (d) => sender.send("chat:delta", { requestId, ...d }))
      .then(() => sender.send("chat:delta", { requestId, done: true }))
      .catch((e: Error) =>
        sender.send("chat:delta", {
          requestId,
          done: true,
          error: e.name === "AbortError" ? undefined : e.message,
          aborted: e.name === "AbortError",
        }),
      );
    return true;
  });
  h("chat:abort", (requestId: string) => abortChat(requestId));
  h("chat:title", async (user: string, assistant: string) => {
    const s = store.getSettings();
    const t = await complete(s, [
      { role: "system", content: "为这段对话生成一个不超过 14 个字的中文标题，只输出标题本身，不要标点和引号。" },
      { role: "user", content: `用户：${user.slice(0, 500)}\n助手：${assistant.slice(0, 500)}` },
    ]);
    return t.replace(/^["'《「]|["'》」。]$/g, "").slice(0, 30);
  });
  h("models:list", () => listModels(store.getSettings()));

  h("app:mcpInfo", () => {
    const script = path.join(app.getAppPath(), "mcp", "screenlens-mcp.mjs");
    return { script, node: process.platform === "win32" ? "node" : "node", exists: fs.existsSync(script) };
  });
  const mcpLaunch = () => ({ command: process.execPath, script: path.join(app.getAppPath(), "mcp", "screenlens-mcp.mjs") });
  h("mcp:status", () => mcpStatus());
  h("mcp:install", (client: McpClient) => installMcp(client, mcpLaunch()));
  h("app:openPath", (p: string) => shell.openPath(p));
  h("app:userData", () => app.getPath("userData"));
  h("app:hide", () => win?.hide());

  h("watch:start", () => startWatch());
  h("watch:stop", () => stopWatch());
  h("watch:state", () => watcher?.state ?? idleWatchState());
  h("watch:windows", () => listWindows());
  h("watch:result", (r: { silent?: boolean; error?: string; convId?: string; text?: string }) => {
    watcher?.reportResult(r);
    if (!r.silent && !r.error && r.convId && r.text && !(win?.isVisible() && win.isFocused())) watchNotify(r.convId, r.text);
  });
  h("shot:delete", (id: string) => deleteShot(id));
}

// ---------------------------------------------------------------- MCP 桥接：供 DSH / Codex / Claude Code 调用
/** MCP annotate 不传 seconds 时的显示时长（秒）。固定值，不读用户设置。 */
const AGENT_ANNOTATE_SECONDS = 5;

async function bridgeHandler(method: string, p: Record<string, unknown>): Promise<unknown> {
  const s = store.getSettings();
  const prep = (shot: ShotRef) =>
    rendererCall<{ dataUrl: string; width: number; height: number }>("image.prepare", {
      shotId: shot.id,
      maxSide: Number(p.max_side) || (method === "watch_next" ? 1280 : s.maxImageSide),
      grid: p.grid === undefined ? true : Boolean(p.grid),
    });
  switch (method) {
    case "ping":
      return { ok: true, version: app.getVersion() };
    case "list_displays":
      return listDisplays().map((d, i) => ({ index: i + 1, ...d }));
    case "screen_capture": {
      let target: "cursor" | number | "primary" = "cursor";
      const d = p.display;
      if (d === "primary") target = "primary";
      else if (typeof d === "number") {
        const list = screen.getAllDisplays();
        target = (list[d - 1] ?? list[0]).id;
      }
      const shot = await captureScreen(target);
      const img = await prep(shot);
      win?.webContents.send("app:agent-activity", { kind: "capture", shot });
      return { shot, image: img };
    }
    case "list_cameras":
      return rendererCall<{ id: string; label: string; virtual?: boolean }[]>("camera.list", {}, 10000);
    case "camera_capture": {
      // 用户确认在这里强制执行：拒绝/超时直接抛错，不会打开摄像头
      const reason = typeof p.reason === "string" ? p.reason.trim().slice(0, 200) : "";
      await ensureCameraConsent(reason);
      const r = await rendererCall<{ dataUrl: string; width: number; height: number; label: string; virtual?: boolean }>(
        "camera.grab",
        // 摄像头若是为这次请求临时打开的，取完帧立即关闭
        { deviceId: p.device_id, closeAfter: true },
        15000,
      );
      const shot = registerShot(saveDataUrlShot(r.dataUrl, "camera", r.label, r.width, r.height));
      const img = await prep(shot);
      win?.webContents.send("app:agent-activity", { kind: "capture", shot });
      // virtual=true 提醒调用方：这是虚拟摄像头，画面可能不是真实场景
      return { shot, image: img, ...(r.virtual ? { virtual: true } : {}) };
    }
    case "annotate": {
      const shotId = (p.shot_id as string) || lastShotId;
      if (!shotId) throw new Error("还没有任何截图，请先调用 screen_capture 或 camera_capture");
      const anns = parseAnnotations(JSON.stringify(p.annotations ?? []));
      if (!anns.length) throw new Error("annotations 为空或格式无效");
      // MCP 的默认时长是固定的（不跟应用设置走），否则用户的 overlaySeconds 会把 MCP 的默认值覆盖掉
      const seconds = p.seconds === undefined ? AGENT_ANNOTATE_SECONDS : Math.max(0, Number(p.seconds) || 0);
      const r = await showShotAnnotations(shotId, anns, seconds, true);
      win?.webContents.send("app:agent-activity", { kind: "annotate", shotId, count: anns.length });
      return { ...r, shot_id: shotId, drawn: anns.length, seconds };
    }
    case "clear_annotations":
      clearAnnotations();
      return { ok: true };
    case "android_capture":
      throw new Error("安卓屏幕共享尚未实现（计划通过 adb / scrcpy 接入）");
    case "list_windows":
      return (await listWindows()).map((w) => ({ id: w.id, name: w.name }));
    case "watch_next": {
      const r = await watchNext(p as AgentWatchParams, s, agentWatchDeps);
      if (r.kind === "timeout") return r;
      const { shot } = r.trigger;
      const image = p.include_image === false ? null : await prep(shot);
      return { ...r, image };
    }
    case "watch_stop":
      return { stopped: stopAgentWatch(agentWatchDeps) };
    default:
      throw new Error(`未知方法: ${method}`);
  }
}

// ---------------------------------------------------------------- 启动
app.on("second-instance", (_e, argv) => {
  if (!argv.includes("--background") && !argv.includes("--service")) showWindow();
});

app.whenReady().then(async () => {
  store.ensureDirs();
  const s = store.getSettings();
  await applyProxy(s.proxy);

  protocol.handle("shot", (req) => {
    const id = new URL(req.url).hostname;
    try {
      const buf = fs.readFileSync(store.shotPath(id));
      return new Response(buf, { headers: { "content-type": "image/jpeg", "access-control-allow-origin": "*" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media" || perm === "clipboard-sanitized-write"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media" || perm === "clipboard-sanitized-write");

  setupIpc();
  createWindow(!serviceMode);
  setOverlayClearedListener(() => win?.webContents.send("app:overlay-state", { active: false }));
  setCameraConsentListener((c) => {
    if (c.grantUntil) {
      const until = new Date(c.grantUntil).toLocaleTimeString().slice(0, 5);
      win?.webContents.send("app:toast", { kind: "info", text: `已允许外部 Agent 使用摄像头至 ${until}（托盘菜单可撤销）` });
    }
  });

  tray = new Tray(makeIcon(32));
  tray.setToolTip(serviceMode ? "ScreenLens 服务（MCP 后端）" : "ScreenLens");
  const revokeConsentItem = {
    label: "撤销 Agent 摄像头授权",
    click: () => {
      const had = revokeCameraConsent();
      win?.webContents.send("app:toast", { kind: "info", text: had ? "已撤销摄像头授权，下次使用会重新询问" : "当前没有摄像头授权" });
    },
  };
  const quitItem = { label: "退出", click: () => ((quitting = true), app.quit()) };
  tray.setContextMenu(
    Menu.buildFromTemplate(
      serviceMode
        ? [{ label: "打开设置", click: showWindow }, revokeConsentItem, { type: "separator" as const }, quitItem]
        : [
            { label: "显示 / 隐藏", click: toggleWindow },
            { label: "截屏提问", click: hotkeyCapture },
            { label: "清除屏幕标注", click: () => clearAnnotations() },
            revokeConsentItem,
            {
              label: "开始 / 停止自动观察",
              click: () => {
                if (watcher) return stopWatch();
                try {
                  startWatch();
                } catch (e) {
                  showWindow();
                  win?.webContents.send("app:toast", { kind: "warn", text: (e as Error).message });
                }
              },
            },
            { type: "separator" as const },
            quitItem,
          ],
    ),
  );
  tray.on("click", serviceMode ? showWindow : toggleWindow);

  const failed = serviceMode ? [] : registerHotkeys(s);
  if (failed.length) {
    windowReady?.then(() =>
      win?.webContents.send("app:toast", { kind: "warn", text: `快捷键注册失败（可能被占用）：${failed.join("、")}` }),
    );
  }

  try {
    await startBridge(bridgeHandler);
  } catch (e) {
    console.error("bridge failed", e);
  }
});

app.on("before-quit", () => {
  quitting = true;
  globalShortcut.unregisterAll();
  watcher?.stop();
  stopAgentWatch();
  destroyOverlays();
  stopBridge();
});

app.on("window-all-closed", () => {
  /* 常驻托盘 */
});

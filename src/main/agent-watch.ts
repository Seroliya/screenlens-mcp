import type { Settings, ShotRef, WatchState, WatchTrigger } from "../shared/types";
import { Watcher } from "./watch";
import { listWindows } from "./capture";

/**
 * MCP 观察会话：外部 Agent 自己当观察者。
 * watch_next 阻塞到下一次\"值得看\"的变化（或超时）。会话在多次调用之间保持，
 * 因此\"与最近发出去的画面比较\"在整个循环里都有效。超过 IDLE_MS 没人来取就自动结束。
 */

export interface AgentWatchParams {
  scope?: "window" | "screen";
  /** 窗口标题的一部分，或 list_windows 返回的 id */
  window?: string;
  sensitivity?: number;
  settle_ms?: number;
  min_interval?: number;
  periodic_min?: number;
  /** 整屏模式下的前台程序白名单（逗号分隔）；不传则不过滤 */
  fg_allow?: string;
  timeout_sec?: number;
}

export type WatchNextResult =
  | { kind: "trigger"; trigger: WatchTrigger; state: WatchState; started: boolean }
  | { kind: "timeout"; state: WatchState; started: boolean; waitedSec: number };

const IDLE_MS = 10 * 60_000;
const STALE_MS = 5 * 60_000;
const CONFIG_KEYS: (keyof AgentWatchParams)[] = ["scope", "window", "sensitivity", "settle_ms", "min_interval", "periodic_min", "fg_allow"];

interface Session {
  watcher: Watcher;
  key: string;
  queue: (WatchTrigger & { at: number })[];
  waiter: ((t: WatchTrigger | null) => void) | null;
  lastCallAt: number;
  idle: NodeJS.Timeout;
}

let session: Session | null = null;

export interface AgentWatchDeps {
  registerShot(s: ShotRef): ShotRef;
  onState(s: WatchState): void;
  onStart(scopeLabel: string): void;
  onStop(): void;
}

async function resolveWindow(q: string): Promise<{ id: string; name: string }> {
  const wins = await listWindows();
  const hit = q.startsWith("window:") ? wins.find((w) => w.id === q) : wins.find((w) => w.name.toLowerCase().includes(q.toLowerCase()));
  if (!hit) {
    const names = wins.slice(0, 15).map((w) => `- ${w.name}`).join("\n");
    throw new Error(`找不到窗口「${q}」。可用窗口：\n${names}`);
  }
  return { id: hit.id, name: hit.name };
}

async function buildSettings(p: AgentWatchParams, base: Settings): Promise<Settings> {
  const scope = p.scope ?? (p.window ? "window" : "screen");
  const s: Settings = {
    ...base,
    watchScope: scope,
    watchFgFilter: !!p.fg_allow,
    watchFgAllow: p.fg_allow ?? "",
    watchSensitivity: p.sensitivity ?? base.watchSensitivity,
    watchSettleMs: p.settle_ms ?? base.watchSettleMs,
    watchMinInterval: p.min_interval ?? 10,
    watchPeriodicMin: p.periodic_min ?? base.watchPeriodicMin,
    watchHourlyCap: 1000, // 节奏由 Agent 的调用控制
    watchMaxChange: 0,
  };
  if (scope === "window") {
    if (!p.window) throw new Error("scope=window 时需要 window 参数（窗口标题的一部分，可先调用 list_windows）");
    const w = await resolveWindow(p.window);
    s.watchWindowId = w.id;
    s.watchWindowName = w.name;
  }
  return s;
}

export function stopAgentWatch(deps?: AgentWatchDeps) {
  if (!session) return false;
  clearInterval(session.idle);
  session.waiter?.(null);
  session.watcher.stop();
  session = null;
  deps?.onStop();
  return true;
}

export function agentWatchState(): WatchState | null {
  return session ? { ...session.watcher.state } : null;
}

export async function watchNext(p: AgentWatchParams, base: Settings, deps: AgentWatchDeps): Promise<WatchNextResult> {
  const hasConfig = CONFIG_KEYS.some((k) => p[k] !== undefined);
  const key = JSON.stringify(CONFIG_KEYS.map((k) => p[k] ?? null));
  let started = false;

  if (!session || (hasConfig && key !== session.key)) {
    stopAgentWatch(deps);
    const s = await buildSettings(p, base);
    const sess: Session = {
      key,
      queue: [],
      waiter: null,
      lastCallAt: Date.now(),
      idle: setInterval(() => {
        if (session === sess && !sess.waiter && Date.now() - sess.lastCallAt > IDLE_MS) stopAgentWatch(deps);
      }, 30_000),
      watcher: null as unknown as Watcher,
    };
    sess.watcher = new Watcher(s, {
      registerShot: deps.registerShot,
      onState: deps.onState,
      onTrigger: (t) => {
        if (sess.waiter) {
          const w = sess.waiter;
          sess.waiter = null;
          w(t);
        } else sess.queue = [{ ...t, at: Date.now() }];
      },
    });
    sess.watcher.start();
    session = sess;
    started = true;
    deps.onStart(sess.watcher.state.scopeLabel);
  }

  const sess = session!;
  sess.lastCallAt = Date.now();
  // 太旧的排队结果丢掉（Agent 隔了很久才回来）
  sess.queue = sess.queue.filter((t) => Date.now() - t.at < STALE_MS);
  const queued = sess.queue.shift();
  if (queued) return { kind: "trigger", trigger: queued, state: { ...sess.watcher.state }, started };

  // 上一次触发已被取走，允许下一次触发
  sess.watcher.release();
  const timeoutSec = Math.max(5, Math.min(170, p.timeout_sec ?? 120));
  const t0 = Date.now();
  const got = await new Promise<WatchTrigger | null>((resolve) => {
    const timer = setTimeout(() => {
      if (sess.waiter === done) sess.waiter = null;
      resolve(null);
    }, timeoutSec * 1000);
    const done = (t: WatchTrigger | null) => {
      clearTimeout(timer);
      resolve(t);
    };
    sess.waiter = done;
  });
  sess.lastCallAt = Date.now();
  const state = { ...sess.watcher.state };
  if (got) return { kind: "trigger", trigger: got, state, started };
  return { kind: "timeout", state, started, waitedSec: Math.round((Date.now() - t0) / 1000) };
}

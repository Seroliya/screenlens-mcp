import { screen } from "electron";
import type { Settings, ShotRef, WatchState, WatchTrigger } from "../shared/types";
import { diffFrames, lumaFromBGRA, parseProcList, procIn, TH, TW, unionMask, type DiffResult } from "../shared/frame-diff";
import { annotationMask } from "../shared/annot-layout";
import { captureDisplay, captureWindow, grabThumb, hwndOf, resolveDisplay } from "./capture";
import { getFg, setFgTarget, startFgHelper, stopFgHelper } from "./fg-helper";
import { recordableOverlay } from "./overlay";
import { mapFromDisplay } from "./watch-map";

/**
 * 自动观察：每秒取一张 160×100 缩略图在本地比较（不花 token），判断\"值得发\"时才截高清图交给 AI。
 *
 * - 与\"最近发出去的几张\"比（不是与上一秒比）：慢慢打字的累计变化也能触发；切走再切回原画面不会重复发送。
 * - 变化够了还要等画面稳定 settleMs，避免打字/滚动/刷屏到一半时发送。
 * - 锁定窗口模式：只看一个窗口（在后台也能截），切屏天然不影响。
 * - 整屏模式：前台程序不在白名单时暂停计数；隐私黑名单程序在前台时一律暂停。
 * - 最短间隔、每小时上限、AI 回复期间不再触发、定时兜底（长时间没变化 → 用户可能卡住了）。
 */

const TICK_MS = 1000;
let watcherSeq = 0;
const KEEP_BASELINES = 6;
const INFLIGHT_TIMEOUT = 120_000;

export interface WatchDeps {
  registerShot(s: ShotRef): ShotRef;
  onTrigger(t: WatchTrigger): void;
  onState(s: WatchState): void;
}

export class Watcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private baselines: Uint8Array[] = [];
  /** 每张基准帧截取时屏幕上标注占据的格子（与 baselines 一一对应） */
  private baselineMasks: (Uint8Array | null)[] = [];
  /** 当前标注掩码及其指纹：标注出现/消失本身不算画面变化 */
  private mask: Uint8Array | null = null;
  private maskKey = "";
  private prev: Uint8Array | null = null;
  private stableSince = 0;
  private lastMotionAt = Date.now();
  private sentTimes: number[] = [];
  private inflightAt = 0;
  private displayId: string;
  private readonly allow: string[];
  private readonly block: string[];
  private readonly owner = `w${++watcherSeq}`;
  private readonly hwnd: string | null;
  state: WatchState;

  constructor(private s: Settings, private deps: WatchDeps) {
    this.hwnd = s.watchScope === "window" ? hwndOf(s.watchWindowId) : null;
    this.allow = parseProcList(s.watchFgAllow);
    this.block = parseProcList(s.watchBlocklist);
    const d = resolveDisplay(s.screenTarget);
    this.displayId = String(d.id);
    const idx = screen.getAllDisplays().findIndex((x) => x.id === d.id);
    this.state = {
      running: false,
      scopeLabel: s.watchScope === "window" ? `窗口「${s.watchWindowName || "未命名"}」` : `屏幕 ${idx + 1}`,
      paused: null,
      ratio: 0,
      phase: "启动中",
      sent: 0,
      silent: 0,
      spoke: 0,
      lastSentAt: 0,
      hourCount: 0,
    };
  }

  start() {
    if (this.s.watchScope === "window" && !this.s.watchWindowId) throw new Error("请先选择要锁定的窗口");
    startFgHelper();
    setFgTarget(this.owner, this.hwnd);
    this.state.running = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit();
  }

  stop() {
    if (!this.state.running) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    stopFgHelper(this.owner);
    this.state = { ...this.state, running: false, phase: "已停止", paused: null };
    this.emit();
  }

  /** 渲染进程报告 AI 这一轮的结果 */
  reportResult(r: { silent?: boolean; error?: string }) {
    this.inflightAt = 0;
    if (r.error) this.state.phase = `AI 出错：${r.error.slice(0, 60)}`;
    else if (r.silent) this.state.silent++;
    else this.state.spoke++;
    this.emit();
  }

  /** MCP 模式：外部 Agent 已取走上一次触发，可以继续触发下一次 */
  release() {
    this.inflightAt = 0;
  }

  private target() {
    return this.hwnd ? getFg()?.targets?.[this.hwnd] : undefined;
  }

  private emit() {
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3600_000);
    this.state.hourCount = this.sentTimes.length;
    this.deps.onState({ ...this.state });
  }

  private pauseReason(): string | null {
    const fg = getFg();
    if (fg && this.block.length && procIn(fg.proc, this.block)) return `隐私暂停：${fg.proc} 在前台`;
    if (this.s.watchScope === "window") {
      const t = this.target();
      if (t && !t.alive) return "锁定的窗口已关闭";
      if (t && t.alive && t.min) return "锁定的窗口已最小化";
      return null;
    }
    if (this.s.watchFgFilter && this.allow.length && fg) {
      if (fg.pid === process.pid) return "ScreenLens 在前台";
      if (!procIn(fg.proc, this.allow)) return `前台是 ${fg.proc || "桌面"}，不在观察名单`;
    }
    return null;
  }

  private async grab(): Promise<Uint8Array | null> {
    const img =
      this.s.watchScope === "window" ? await grabThumb("window", this.s.watchWindowId) : await grabThumb("screen", this.displayId);
    if (!img) return null;
    const small = img.resize({ width: TW, height: TH, quality: "good" });
    return lumaFromBGRA(small.toBitmap(), TW, TH);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const pause = this.pauseReason();
      if (pause) {
        // 暂停期间看到的画面不计入：回来后继续与\"上次发出去的\"比较
        this.prev = null;
        this.stableSince = 0;
        if (this.state.paused !== pause) {
          this.state.paused = pause;
          this.emit();
        }
        return;
      }
      this.state.paused = null;

      this.updateMask();
      const frame = await this.grab();
      if (!frame) {
        this.state.paused = this.s.watchScope === "window" ? "找不到锁定的窗口" : "截屏失败";
        this.emit();
        return;
      }
      const now = Date.now();

      // 画面是否在动（与上一秒比）
      const motion = this.prev ? diffFrames(this.prev, frame, undefined, this.mask) : null;
      this.prev = frame;
      if (motion && motion.cells > 1) {
        this.stableSince = 0;
        this.lastMotionAt = now;
      } else if (!this.stableSince) this.stableSince = now;
      const stable = !!this.stableSince && now - this.stableSince >= this.s.watchSettleMs;

      const inflight = this.inflightAt && now - this.inflightAt < INFLIGHT_TIMEOUT;
      const sens = this.s.watchSensitivity / 100;

      // 第一帧：直接发一次，让 AI 先了解现场
      if (!this.baselines.length) {
        if (stable && !inflight) await this.send(frame, "开始观察", null);
        else this.setPhase("等待画面稳定", 0);
        return;
      }

      // 与最近发出去的几张逐一比较：最接近的那张作为基准
      let best: DiffResult | null = null;
      let bestIdx = 0;
      this.baselines.forEach((b, i) => {
        const d = diffFrames(b, frame, undefined, unionMask(this.mask, this.baselineMasks[i] ?? null));
        if (!best || d.ratio < best.ratio) {
          best = d;
          bestIdx = i;
        }
      });
      const vsLast = diffFrames(this.baselines[0], frame, undefined, unionMask(this.mask, this.baselineMasks[0] ?? null));
      if (bestIdx > 0 && best!.ratio < sens) {
        // 切回了之前发过的画面：把它提到最前，后续变化在它的基础上累计
        const [b] = this.baselines.splice(bestIdx, 1);
        this.baselines.unshift(b);
        const [bm] = this.baselineMasks.splice(bestIdx, 1);
        this.baselineMasks.unshift(bm);
      }
      const change = bestIdx > 0 && best!.ratio < sens ? best! : vsLast;

      if (inflight) return this.setPhase("AI 正在看", change.ratio);
      const maxC = this.s.watchMaxChange / 100;
      if (maxC > 0 && change.ratio > maxC) return this.setPhase("变化过大，视为切屏", change.ratio);

      const sinceSent = now - this.state.lastSentAt;
      const cooldown = sinceSent < this.s.watchMinInterval * 1000;
      const capped = this.sentTimes.filter((t) => now - t < 3600_000).length >= this.s.watchHourlyCap;

      if (change.ratio >= sens) {
        if (!stable) return this.setPhase("画面在变化，等待稳定", change.ratio);
        if (capped) return this.setPhase("已达每小时上限", change.ratio);
        if (cooldown) return this.setPhase(`冷却中 ${Math.ceil((this.s.watchMinInterval * 1000 - sinceSent) / 1000)}s`, change.ratio);
        await this.send(frame, `画面变化约 ${Math.round(change.ratio * 100)}%`, change.bbox);
        return;
      }

      const periodic = this.s.watchPeriodicMin * 60_000;
      if (periodic > 0 && sinceSent >= periodic && stable && !capped) {
        const idleMin = Math.round((now - this.lastMotionAt) / 60_000);
        const why =
          idleMin >= this.s.watchPeriodicMin
            ? `定时检查：画面已约 ${idleMin} 分钟没有明显变化（用户可能卡住了）`
            : `定时检查：距上次查看已 ${Math.round(sinceSent / 60_000)} 分钟，期间只有零星变化`;
        await this.send(frame, why, change.cells ? change.bbox : null);
        return;
      }
      this.setPhase(change.cells ? "有零星变化，未达阈值" : "等待变化", change.ratio);
    } catch (e) {
      this.state.phase = `出错：${(e as Error).message}`;
      this.emit();
    } finally {
      this.busy = false;
    }
  }

  /**
   * 屏幕上显示着可被录制的标注时，算出它们在本观察画面中占据的格子，比较时忽略。
   * 标注出现/消失/变化的那一刻重置"是否在动"的判断，避免标注动画本身被当成画面变化。
   */
  private updateMask() {
    const ov = recordableOverlay();
    let mask: Uint8Array | null = null;
    const d = ov && screen.getAllDisplays().find((x) => x.id === ov.displayId);
    if (ov && d) {
      if (this.s.watchScope === "window") {
        const t = this.target();
        if (t && t.alive) {
          const phys = { x: t.x, y: t.y, width: t.w, height: t.h };
          const rect = process.platform === "win32" ? screen.screenToDipRect(null, phys) : phys;
          if (rect.width > 0 && rect.height > 0) mask = annotationMask(mapFromDisplay(ov.annotations, rect, d.bounds), rect.width, rect.height);
        }
      } else if (String(d.id) === this.displayId) {
        mask = annotationMask(ov.annotations, d.bounds.width, d.bounds.height);
      }
      if (mask && !mask.some(Boolean)) mask = null;
    }
    const key = mask ? mask.join("") : "";
    if (key !== this.maskKey) {
      this.prev = null;
      this.stableSince = 0;
    }
    this.mask = mask;
    this.maskKey = key;
  }

  private setPhase(phase: string, ratio: number) {
    if (this.state.phase === phase && Math.abs(this.state.ratio - ratio) < 0.005) return;
    this.state.phase = phase;
    this.state.ratio = ratio;
    this.emit();
  }

  private async send(frame: Uint8Array, reason: string, bbox: [number, number, number, number] | null) {
    let shot: ShotRef;
    if (this.s.watchScope === "window") {
      const t = this.target();
      const rect = t && t.alive ? t : null;
      shot = await captureWindow(this.s.watchWindowId, this.s.watchWindowName, rect?.w ?? 0, rect?.h ?? 0);
      if (rect && process.platform === "win32") {
        // 记录窗口在屏幕上的位置，标注才能投影回真实屏幕
        const dip = screen.screenToDipRect(null, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
        shot.screenRect = dip;
        shot.displayId = screen.getDisplayMatching(dip).id;
      }
    } else {
      const d = screen.getAllDisplays().find((x) => String(x.id) === this.displayId) ?? resolveDisplay("cursor");
      shot = await captureDisplay(d);
    }
    this.deps.registerShot(shot);

    const now = Date.now();
    this.baselines.unshift(frame);
    this.baselines.length = Math.min(this.baselines.length, KEEP_BASELINES);
    this.baselineMasks.unshift(this.mask);
    this.baselineMasks.length = this.baselines.length;
    this.sentTimes.push(now);
    this.inflightAt = now;
    this.state.sent++;
    this.state.lastSentAt = now;
    this.state.ratio = 0;
    this.state.phase = "AI 正在看";
    this.emit();

    const region = bbox ? `；变化主要集中在区域 [${bbox.map((v) => Math.round(v)).join(", ")}]（0~1000 归一化坐标）` : "";
    const marked = this.mask ? "；画面上仍显示着之前画的标注（不是界面内容）" : "";
    this.deps.onTrigger({ shot, reason: reason + region + marked, scopeLabel: this.state.scopeLabel });
  }
}

export { mapToDisplay } from "./watch-map";

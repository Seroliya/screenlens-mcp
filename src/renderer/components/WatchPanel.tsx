import { useEffect, useState } from "react";
import type { Settings, WatchState } from "../../shared/types";

interface WinInfo {
  id: string;
  name: string;
  thumb: string;
  icon?: string;
}

export function ago(t: number) {
  if (!t) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return `${Math.round(s / 3600)} 小时前`;
}

/** 自动观察：范围选择、参数、开始/停止与实时状态 */
export function WatchPanel(props: {
  settings: Settings;
  state: WatchState;
  onClose(): void;
  onSaved(s: Settings): void;
  onError(msg: string): void;
}) {
  const [d, setD] = useState<Settings>(props.settings);
  const [wins, setWins] = useState<WinInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setD((p) => ({ ...p, [k]: v }));
  const running = props.state.running;

  const loadWins = async () => {
    setWins(null);
    try {
      setWins(await window.api.watch.windows());
    } catch (e) {
      props.onError((e as Error).message);
      setWins([]);
    }
  };
  useEffect(() => {
    if (d.watchScope === "window" && !wins) loadWins();
  }, [d.watchScope]);

  const start = async () => {
    setBusy(true);
    try {
      const r = await window.api.settings.set(d);
      props.onSaved(r.settings);
      if (running) await window.api.watch.stop();
      await window.api.watch.start();
      props.onClose();
    } catch (e) {
      props.onError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
    setBusy(false);
  };

  const st = props.state;
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal watch">
        <div className="modal-head">
          <h3>👁 自动观察</h3>
          <button className="ghost" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {running && (
            <div className="watch-status">
              <div>
                <span className="live-dot" /> 观察中：<b>{st.scopeLabel}</b>
                {st.paused ? <span className="paused"> · 暂停：{st.paused}</span> : <span className="muted"> · {st.phase}</span>}
              </div>
              <div className="watch-meter">
                <div style={{ width: `${Math.min(100, (st.ratio / Math.max(0.01, d.watchSensitivity / 100)) * 100)}%` }} />
              </div>
              <small className="muted">
                距上次发送变化 {Math.round(st.ratio * 100)}%（阈值 {d.watchSensitivity}%） · 已发送 {st.sent} 次 · AI 提醒 {st.spoke} 次 · 沉默 {st.silent} 次 ·
                本小时 {st.hourCount}/{d.watchHourlyCap} · 上次 {ago(st.lastSentAt)}
              </small>
            </div>
          )}

          <label className="field">
            <span>你在做什么？（告诉 AI 什么时候该提醒你）</span>
            <textarea
              rows={2}
              value={d.watchTask}
              placeholder="例如：我在学 Python 写爬虫，出现报错、写法明显有问题、或者我卡住时提醒我"
              onChange={(e) => set("watchTask", e.target.value)}
            />
          </label>

          <div className="field">
            <span>观察范围</span>
            <div className="segmented wide">
              <button className={d.watchScope === "window" ? "on" : ""} onClick={() => set("watchScope", "window")}>
                🪟 锁定一个窗口（推荐，切屏不影响）
              </button>
              <button className={d.watchScope === "screen" ? "on" : ""} onClick={() => set("watchScope", "screen")}>
                🖥 整个屏幕
              </button>
            </div>
          </div>

          {d.watchScope === "window" ? (
            <div className="field">
              <span>
                选择窗口 {d.watchWindowName && <b className="sel-name">当前：{d.watchWindowName}</b>}
                <button className="ghost tiny" onClick={loadWins}>
                  刷新
                </button>
              </span>
              {!wins ? (
                <div className="muted">正在列出窗口…</div>
              ) : (
                <div className="win-grid">
                  {wins.map((w) => (
                    <button
                      key={w.id}
                      className={`win-card ${d.watchWindowId === w.id ? "on" : ""}`}
                      title={w.name}
                      onClick={() => setD((p) => ({ ...p, watchWindowId: w.id, watchWindowName: w.name }))}
                    >
                      <img src={w.thumb} />
                      <span>
                        {w.icon && <img className="ico" src={w.icon} />}
                        {w.name}
                      </span>
                    </button>
                  ))}
                  {!wins.length && <div className="muted">没有可选的窗口</div>}
                </div>
              )}
              <small className="muted">被锁定的窗口在其它窗口后面也能看到（最小化时暂停）。窗口关闭后需重新选择。</small>
            </div>
          ) : (
            <>
              <label className="check">
                <input type="checkbox" checked={d.watchFgFilter} onChange={(e) => set("watchFgFilter", e.target.checked)} />
                只在下列程序位于前台时观察（切到其它程序时暂停计数）
              </label>
              {d.watchFgFilter && (
                <label className="field">
                  <span>前台程序白名单（进程名，逗号分隔）</span>
                  <input value={d.watchFgAllow} onChange={(e) => set("watchFgAllow", e.target.value)} />
                </label>
              )}
            </>
          )}

          <label className="field">
            <span>隐私黑名单：这些程序在前台时一律暂停</span>
            <input value={d.watchBlocklist} onChange={(e) => set("watchBlocklist", e.target.value)} />
          </label>

          <details className="manual" open={!running}>
            <summary>触发参数</summary>
            <div className="grid2">
              <label className="field">
                <span>灵敏度：变化 ≥ {d.watchSensitivity}% 的区域</span>
                <input type="range" min={1} max={25} value={d.watchSensitivity} onChange={(e) => set("watchSensitivity", +e.target.value)} />
              </label>
              <label className="field">
                <span>画面稳定 {(d.watchSettleMs / 1000).toFixed(1)} 秒后再截图</span>
                <input type="range" min={500} max={6000} step={250} value={d.watchSettleMs} onChange={(e) => set("watchSettleMs", +e.target.value)} />
              </label>
              <label className="field">
                <span>两次发送至少间隔 {d.watchMinInterval} 秒</span>
                <input type="range" min={5} max={300} step={5} value={d.watchMinInterval} onChange={(e) => set("watchMinInterval", +e.target.value)} />
              </label>
              <label className="field">
                <span>定时兜底：{d.watchPeriodicMin ? `每 ${d.watchPeriodicMin} 分钟至少看一次` : "关闭"}</span>
                <input type="range" min={0} max={30} value={d.watchPeriodicMin} onChange={(e) => set("watchPeriodicMin", +e.target.value)} />
              </label>
              <label className="field">
                <span>每小时最多发送 {d.watchHourlyCap} 次</span>
                <input type="range" min={5} max={120} step={5} value={d.watchHourlyCap} onChange={(e) => set("watchHourlyCap", +e.target.value)} />
              </label>
              <label className="field">
                <span>变化上限：{d.watchMaxChange ? `超过 ${d.watchMaxChange}% 视为切屏、不发送` : "关闭"}</span>
                <input type="range" min={0} max={100} step={5} value={d.watchMaxChange} onChange={(e) => set("watchMaxChange", +e.target.value)} />
              </label>
            </div>
            <small className="muted">
              每秒在本地比较一张很小的缩略图，不花 token；只有和「最近发出去的画面」相比变化够大、且画面停下来后，才截高清图发给 AI。AI 没话说时会保持沉默，不打扰你。
            </small>
          </details>
        </div>
        <div className="modal-foot">
          {running && (
            <button className="stop" onClick={() => window.api.watch.stop()}>
              ■ 停止观察
            </button>
          )}
          <div className="spacer" />
          <button className="ghost" onClick={props.onClose}>
            关闭
          </button>
          <button className="primary" disabled={busy || (d.watchScope === "window" && !d.watchWindowId)} onClick={start}>
            {running ? "应用并重新开始" : "开始观察"}
          </button>
        </div>
      </div>
    </div>
  );
}

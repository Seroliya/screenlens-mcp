import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, ChatMessage, Conversation, ConversationMeta, DisplayInfo, Settings, ShotRef } from "../shared/types";
import { splitAnnotations } from "../shared/annotations";
import { buildMessages, groupByShot, uid } from "./lib/chat";
import { grabFrame } from "./lib/camera";
import { Sidebar } from "./components/Sidebar";
import { AssistantMessage, UserMessage, type MessageActions } from "./components/MessageView";
import { Composer } from "./components/Composer";
import { CameraPanel } from "./components/CameraPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { AnnotatedImage } from "./components/AnnotatedImage";
import { McpConnect, loadMcpStatus } from "./components/McpConnect";
import { WatchPanel, ago } from "./components/WatchPanel";
import { buildWatchMessages, plainSnippet } from "./lib/watch";
import { isSilent } from "../shared/prompt";
import type { WatchState, WatchTrigger } from "../shared/types";

type Source = "screen" | "camera" | "android";
type Toast = { id: number; kind: "info" | "ok" | "warn" | "error"; text: string };
const SOURCE_LABEL: Record<Source, string> = { screen: "屏幕", camera: "摄像头", android: "安卓屏幕" };

const SUGGESTIONS = ["屏幕上这个报错是什么意思？怎么解决？", "帮我找到设置/保存按钮在哪", "解释一下屏幕上的这段代码", "这个界面下一步该点哪里？"];

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [list, setList] = useState<ConversationMeta[]>([]);
  const [convs, setConvs] = useState<Record<string, Conversation>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [pending, setPending] = useState<ShotRef[]>([]);
  const [source, setSource] = useState<Source>("screen");
  const [cameraId, setCameraId] = useState<string | undefined>();
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [streams, setStreams] = useState<Record<string, string>>({}); // requestId -> convId
  const [overlayActive, setOverlayActive] = useState(false);
  const [cameraFrozen, setCameraFrozen] = useState<{ shot: ShotRef; anns: Annotation[] } | null>(null);
  const [viewer, setViewer] = useState<{ shot: ShotRef; anns: Annotation[] } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [focusSignal, setFocusSignal] = useState(0);
  const [mcpPending, setMcpPending] = useState(false);
  const [watchState, setWatchState] = useState<WatchState | null>(null);
  const [showWatch, setShowWatch] = useState(false);
  const [agentWatch, setAgentWatch] = useState<WatchState | null>(null);
  const watchConvId = useRef<string | null>(null);
  const runWatchRef = useRef<(t: WatchTrigger) => void>(() => {});

  const reqMap = useRef(new Map<string, { convId: string; msgId: string }>());
  const convsRef = useRef(convs);
  convsRef.current = convs;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const scroller = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3200);
  }, []);

  const refreshList = useCallback(async () => setList(await window.api.conv.list()), []);

  // ------------------------------------------------------------ 初始化
  useEffect(() => {
    window.api.settings.get().then(setSettings);
    window.api.displays().then(setDisplays);
    window.api.watch.state().then(setWatchState);
    loadMcpStatus().then((l) => setMcpPending(l.some((s) => s.detected && !s.registered))).catch(() => {});
    refreshList();
    const offs = [
      window.api.on.attachShot((shot: ShotRef) => {
        setPending((p) => [...p, shot]);
        setFocusSignal((n) => n + 1);
      }),
      window.api.on.toast((t: { kind: Toast["kind"]; text: string }) => toast(t.kind, t.text)),
      window.api.on.overlayState((s: { active: boolean }) => setOverlayActive(s.active)),
      window.api.on.showAnnotated((p: { shot: ShotRef; annotations: Annotation[] }) => {
        if (p.shot.source === "camera") {
          setSource("camera");
          setCameraFrozen({ shot: p.shot, anns: p.annotations });
        } else setViewer({ shot: p.shot, anns: p.annotations });
      }),
      window.api.watch.onState((s: WatchState) => setWatchState(s)),
      window.api.watch.onAgentState((s: WatchState | null) => setAgentWatch(s?.running ? s : null)),
      window.api.watch.onTrigger((t: WatchTrigger) => runWatchRef.current(t)),
      window.api.on.openConv((id: string) => selectConvRef.current(id)),
      window.api.on.agentActivity((a: { kind: string; count?: number; shot?: ShotRef }) => {
        toast("info", a.kind === "capture" ? `外部 Agent 截取了${a.shot?.source === "camera" ? "摄像头画面" : "屏幕"}` : `外部 Agent 画了 ${a.count} 处标注`);
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [refreshList, toast]);

  // ------------------------------------------------------------ 对话缓存操作
  const persist = useCallback(
    async (c: Conversation) => {
      await window.api.conv.save(c);
      refreshList();
    },
    [refreshList],
  );

  const patchMessage = useCallback((convId: string, msgId: string, fn: (m: ChatMessage) => ChatMessage) => {
    setConvs((p) => {
      const c = p[convId];
      if (!c) return p;
      return { ...p, [convId]: { ...c, messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)) } };
    });
  }, []);

  const selectConv = useCallback(async (id: string) => {
    if (!convsRef.current[id]) {
      const c = await window.api.conv.get(id);
      if (!c) return;
      setConvs((p) => ({ ...p, [id]: c }));
    }
    setCurrentId(id);
    stickBottom.current = true;
  }, []);
  const selectConvRef = useRef(selectConv);
  selectConvRef.current = selectConv;

  // ------------------------------------------------------------ 标注投影
  const project = useCallback(
    async (shot: ShotRef, anns: Annotation[]) => {
      if (shot.source === "screen" || (shot.source === "window" && shot.screenRect)) {
        try {
          await window.api.overlay.show(shot.id, anns);
        } catch (e) {
          toast("error", `无法在屏幕上显示：${(e as Error).message}`);
        }
      } else if (shot.source === "camera") {
        setSource("camera");
        setCameraFrozen({ shot, anns });
      } else setViewer({ shot, anns });
    },
    [toast],
  );

  // ------------------------------------------------------------ 流式结束
  const finish = useCallback(
    async (r: { convId: string; msgId: string }, error?: string) => {
      const c = convsRef.current[r.convId];
      if (!c) return;
      const idx = c.messages.findIndex((m) => m.id === r.msgId);
      if (idx < 0) return;
      const m = c.messages[idx];
      const { annotations } = splitAnnotations(m.content);
      const user = c.messages.slice(0, idx).reverse().find((x) => x.role === "user");
      const shots = user?.shots ?? [];

      // 观察模式：AI 沉默时整轮丢弃（连同截图），只计数
      if (c.kind === "watch") {
        if (!error && isSilent(m.content)) {
          const drop = new Set([m.id, user?.id]);
          const nc: Conversation = { ...c, messages: c.messages.filter((x) => !drop.has(x.id)) };
          setConvs((p) => ({ ...p, [nc.id]: nc }));
          await persist(nc);
          shots.forEach((s) => window.api.deleteShot(s.id));
          window.api.watch.result({ silent: true });
          return;
        }
        window.api.watch.result({ silent: false, error, convId: c.id, text: plainSnippet(splitAnnotations(m.content).text) });
      }

      const nm: ChatMessage = { ...m, annotations, targetShotIds: shots.map((s) => s.id), error };
      const nc: Conversation = { ...c, messages: c.messages.map((x) => (x.id === nm.id ? nm : x)), updatedAt: Date.now() };
      setConvs((p) => ({ ...p, [nc.id]: nc }));
      await persist(nc);

      if (annotations.length && shots.length) {
        // 屏幕覆盖层一次只显示一组；摄像头冻结到对应帧
        const groups = groupByShot(shots, annotations);
        const screenGroup = [...groups].reverse().find((g) => g.shot.source === "screen" || g.shot.source === "window");
        if (screenGroup) project(screenGroup.shot, screenGroup.anns);
        const camGroup = [...groups].reverse().find((g) => g.shot.source === "camera");
        if (camGroup) setCameraFrozen({ shot: camGroup.shot, anns: camGroup.anns });
      }

      // 首轮问答后自动生成标题
      if (!error && m.content && c.kind !== "watch" && c.messages.filter((x) => x.role === "user").length === 1) {
        try {
          const title = await window.api.chat.title(user?.content || "（截图提问）", splitAnnotations(m.content).text);
          if (title) {
            const latest = convsRef.current[nc.id] ?? nc;
            const t = { ...latest, title };
            setConvs((p) => ({ ...p, [t.id]: t }));
            await persist(t);
          }
        } catch {
          /* 标题失败不影响使用 */
        }
      }
    },
    [persist, project],
  );

  useEffect(
    () =>
      window.api.chat.onDelta((d: { requestId: string; content?: string; reasoning?: string; done?: boolean; error?: string }) => {
        const r = reqMap.current.get(d.requestId);
        if (!r) return;
        if (d.content || d.reasoning) {
          patchMessage(r.convId, r.msgId, (m) => ({
            ...m,
            content: m.content + (d.content ?? ""),
            reasoning: d.reasoning ? (m.reasoning ?? "") + d.reasoning : m.reasoning,
          }));
        }
        if (d.done) {
          reqMap.current.delete(d.requestId);
          setStreams((p) => {
            const n = { ...p };
            delete n[d.requestId];
            return n;
          });
          // 等最后一批 delta 渲染进 convsRef 再收尾
          setTimeout(() => finish(r, d.error), 0);
        }
      }),
    [patchMessage, finish],
  );

  // ------------------------------------------------------------ 自动观察：每次触发是一轮单独请求，记入专门的观察对话，不抢焦点
  runWatchRef.current = async (t: WatchTrigger) => {
    const s = settingsRef.current;
    if (!s) return;
    let conv = watchConvId.current ? convsRef.current[watchConvId.current] : undefined;
    if (!conv) {
      const now = new Date();
      conv = {
        id: uid(),
        kind: "watch",
        title: `👁 观察 · ${t.scopeLabel} · ${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
        messages: [],
      };
      watchConvId.current = conv.id;
    }
    const userMsg: ChatMessage = { id: uid(), role: "user", content: `[自动观察] ${t.reason}`, shots: [t.shot], createdAt: Date.now() };
    const asst: ChatMessage = { id: uid(), role: "assistant", content: "", model: s.model, createdAt: Date.now() };
    const prior = conv.messages;
    const nc: Conversation = { ...conv, messages: [...prior, userMsg, asst], updatedAt: Date.now() };
    setConvs((p) => ({ ...p, [nc.id]: nc }));
    await persist(nc);

    const requestId = uid();
    reqMap.current.set(requestId, { convId: nc.id, msgId: asst.id });
    setStreams((p) => ({ ...p, [requestId]: nc.id }));
    try {
      await window.api.chat.start(requestId, await buildWatchMessages(prior, userMsg, s, t.scopeLabel));
    } catch (e) {
      reqMap.current.delete(requestId);
      setStreams((p) => {
        const n = { ...p };
        delete n[requestId];
        return n;
      });
      setTimeout(() => finish({ convId: nc.id, msgId: asst.id }, (e as Error).message), 0);
    }
  };

  // ------------------------------------------------------------ 截取
  const captureNow = useCallback(async (): Promise<ShotRef> => {
    const s = settingsRef.current!;
    if (source === "screen") return window.api.capture.screen(s.screenTarget);
    if (source === "camera") {
      setCameraFrozen(null);
      const f = await grabFrame(cameraId);
      return window.api.capture.dataUrl(f.dataUrl, "camera", f.label, f.width, f.height);
    }
    throw new Error("安卓屏幕共享尚未实现");
  }, [source, cameraId]);

  const addFiles = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        const dataUrl = await new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(f);
        });
        try {
          const shot: ShotRef = await window.api.capture.dataUrl(dataUrl, "upload", f.name || "粘贴的图片");
          setPending((p) => [...p, shot]);
        } catch (e) {
          toast("error", (e as Error).message);
        }
      }
    },
    [toast],
  );

  // ------------------------------------------------------------ 发送
  const currentStreamId = useMemo(() => Object.entries(streams).find(([, cid]) => cid === currentId)?.[0], [streams, currentId]);

  const send = useCallback(
    async (text: string) => {
      const s = settingsRef.current;
      if (!s) return;
      if (!s.apiKey && !/127\.0\.0\.1|localhost/.test(s.baseUrl)) {
        toast("warn", "请先在设置里填写 API Key");
        setShowSettings(true);
        return;
      }
      let shots = pending;
      if (!shots.length && s.autoCapture && source !== "android") {
        try {
          shots = [await captureNow()];
        } catch (e) {
          toast("warn", `自动截取失败，将只发送文字：${(e as Error).message}`);
        }
      }
      if (!text.trim() && !shots.length) return;
      setPending([]);

      const base = (currentId && convsRef.current[currentId]) || {
        id: uid(),
        title: text.trim().slice(0, 24) || "截图提问",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      const userMsg: ChatMessage = { id: uid(), role: "user", content: text.trim(), shots, createdAt: Date.now() };
      const asst: ChatMessage = { id: uid(), role: "assistant", content: "", model: s.model, createdAt: Date.now() };
      const history = [...base.messages, userMsg];
      const nc: Conversation = { ...base, messages: [...history, asst], updatedAt: Date.now() };
      setConvs((p) => ({ ...p, [nc.id]: nc }));
      setCurrentId(nc.id);
      stickBottom.current = true;
      await persist(nc);

      const requestId = uid();
      reqMap.current.set(requestId, { convId: nc.id, msgId: asst.id });
      setStreams((p) => ({ ...p, [requestId]: nc.id }));
      try {
        const msgs = await buildMessages(history, s);
        await window.api.chat.start(requestId, msgs);
      } catch (e) {
        reqMap.current.delete(requestId);
        setStreams((p) => {
          const n = { ...p };
          delete n[requestId];
          return n;
        });
        patchMessage(nc.id, asst.id, (m) => ({ ...m, error: (e as Error).message }));
        setTimeout(() => finish({ convId: nc.id, msgId: asst.id }, (e as Error).message), 0);
      }
    },
    [pending, source, currentId, captureNow, persist, patchMessage, finish, toast],
  );

  // ------------------------------------------------------------ 自动滚动
  const current = currentId ? convs[currentId] : null;
  useEffect(() => {
    const el = scroller.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [current?.messages]);

  const actions: MessageActions = useMemo(() => ({ openViewer: (shot, anns) => setViewer({ shot, anns }), project }), [project]);

  const streamingConvIds = useMemo(() => new Set(Object.values(streams)), [streams]);

  if (!settings) return <div className="boot">加载中…</div>;

  return (
    <div className={`app ${sidebarOpen ? "" : "no-sidebar"}`}>
      {sidebarOpen && (
        <Sidebar
          list={list}
          currentId={currentId}
          streamingIds={streamingConvIds}
          onSelect={selectConv}
          onNew={() => {
            setCurrentId(null);
            setFocusSignal((n) => n + 1);
          }}
          onRename={async (id, title) => {
            const c = convsRef.current[id] ?? (await window.api.conv.get(id));
            if (!c) return;
            const nc = { ...c, title };
            setConvs((p) => ({ ...p, [id]: nc }));
            persist(nc);
          }}
          onPin={async (id, pinned) => {
            const c = convsRef.current[id] ?? (await window.api.conv.get(id));
            if (!c) return;
            const nc = { ...c, pinned };
            setConvs((p) => ({ ...p, [id]: nc }));
            persist(nc);
          }}
          onDelete={async (id) => {
            await window.api.conv.delete(id);
            setConvs((p) => {
              const n = { ...p };
              delete n[id];
              return n;
            });
            if (currentId === id) setCurrentId(null);
            refreshList();
          }}
          onSettings={() => setShowSettings(true)}
        />
      )}

      <main className="main">
        <header className="topbar drag">
          <button className="ghost icon no-drag" title="侧栏" onClick={() => setSidebarOpen(!sidebarOpen)}>
            ☰
          </button>
          <div className="title no-drag">{current?.title ?? "新对话"}</div>
          <div className="segmented no-drag">
            {(["screen", "camera", "android"] as Source[]).map((k) => (
              <button
                key={k}
                className={source === k ? "on" : ""}
                disabled={k === "android"}
                title={k === "android" ? "即将支持：通过 adb / scrcpy 共享安卓屏幕" : ""}
                onClick={() => setSource(k)}
              >
                {k === "screen" ? "🖥 屏幕" : k === "camera" ? "📷 摄像头" : "📱 安卓（即将支持）"}
              </button>
            ))}
          </div>
          {source === "screen" && displays.length > 1 && (
            <select
              className="no-drag"
              value={String(settings.screenTarget)}
              onChange={async (e) => {
                const v = e.target.value === "cursor" ? "cursor" : +e.target.value;
                const r = await window.api.settings.set({ screenTarget: v });
                setSettings(r.settings);
              }}
            >
              <option value="cursor">光标所在屏幕</option>
              {displays.map((d, i) => (
                <option key={d.id} value={d.id}>
                  屏幕 {i + 1}
                  {d.primary ? "（主）" : ""}
                </option>
              ))}
            </select>
          )}
          <button
            className={`watch-pill no-drag ${watchState?.running ? (watchState.paused ? "paused" : "on") : ""}`}
            title={watchState?.running ? `${watchState.paused ?? watchState.phase}（点击查看 / 停止）` : "自动观察：画面变化或定时发送给 AI"}
            onClick={() => setShowWatch(true)}
          >
            {watchState?.running ? (
              <>
                <span className="live-dot" />
                观察中 · 发 {watchState.sent} · 提醒 {watchState.spoke} · 沉默 {watchState.silent} · {ago(watchState.lastSentAt)}
              </>
            ) : (
              "👁 自动观察"
            )}
          </button>
          {agentWatch && (
            <span
              className={`watch-pill no-drag ${agentWatch.paused ? "paused" : "on"}`}
              title={`外部 Agent（通过 MCP）正在观察${agentWatch.scopeLabel}：${agentWatch.paused ?? agentWatch.phase}。Agent 停止调用 10 分钟后自动结束，也可从托盘退出。`}
            >
              <span className="live-dot" />
              Agent 观察 · {agentWatch.scopeLabel} · 发 {agentWatch.sent}
            </span>
          )}
          {overlayActive && (
            <button className="warn-btn no-drag" onClick={() => window.api.overlay.clear()}>
              清除屏幕标注
            </button>
          )}
          <span className="model-badge no-drag" title={settings.baseUrl} onClick={() => setShowSettings(true)}>
            {settings.model || "未选择模型"}
          </span>
        </header>

        {source === "camera" && (
          <CameraPanel deviceId={cameraId} onDevice={(id) => setCameraId(id || undefined)} frozen={cameraFrozen} onUnfreeze={() => setCameraFrozen(null)} />
        )}

        <div
          className="messages"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {!current?.messages.length ? (
            <div className="empty">
              <div className="empty-logo">◉</div>
              <h2>看见你所看见的</h2>
              <p className="muted">
                提问时自动截取{SOURCE_LABEL[source]}，AI 会在你的屏幕上用 <b>框</b>、<b>圈</b>、<b>箭头</b> 指给你看。
                <br />
                全局快捷键 <kbd>{settings.hotkeyCapture}</kbd> 截屏提问，<kbd>{settings.hotkeyToggle}</kbd> 显示/隐藏窗口，<kbd>Esc</kbd> 清除标注。
              </p>
              {mcpPending && !settings.mcpPromptDismissed && (
                <div className="mcp-card">
                  <div className="mcp-card-head">
                    <b>让 DSH / Codex / Claude Code 也能看见你的屏幕</b>
                    <button
                      className="ghost tiny"
                      onClick={async () => setSettings((await window.api.settings.set({ mcpPromptDismissed: true })).settings)}
                    >
                      不再提示
                    </button>
                  </div>
                  <p className="muted">一键接入后，这些 Agent 里的模型可以截屏、看摄像头，并在你屏幕上画框、圈、箭头。</p>
                  <McpConnect compact onChange={(l) => setMcpPending(l.some((s) => s.detected && !s.registered))} />
                </div>
              )}
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="thread">
              {current.messages.map((m, i) => {
                if (m.role === "user") return <UserMessage key={m.id} m={m} actions={actions} />;
                const user = current.messages.slice(0, i).reverse().find((x) => x.role === "user");
                const streaming = !!currentStreamId && reqMap.current.get(currentStreamId)?.msgId === m.id;
                return <AssistantMessage key={m.id} m={m} shots={user?.shots ?? []} streaming={streaming} actions={actions} />;
              })}
            </div>
          )}
        </div>

        <Composer
          pending={pending}
          busy={!!currentStreamId}
          autoCapture={settings.autoCapture && source !== "android"}
          sourceLabel={SOURCE_LABEL[source]}
          focusSignal={focusSignal}
          onSend={send}
          onStop={() => currentStreamId && window.api.chat.abort(currentStreamId)}
          onCapture={async () => {
            try {
              const shot = await captureNow();
              setPending((p) => [...p, shot]);
            } catch (e) {
              toast("error", `截取失败：${(e as Error).message}`);
            }
          }}
          onFiles={addFiles}
          onRemoveShot={(id) => setPending((p) => p.filter((s) => s.id !== id))}
          onToggleAuto={async (v) => setSettings((await window.api.settings.set({ autoCapture: v })).settings)}
          onPreview={(shot) => setViewer({ shot, anns: [] })}
        />
      </main>

      {viewer && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setViewer(null)}>
          <div className="viewer">
            <AnnotatedImage shot={viewer.shot} anns={viewer.anns} animate />
            <div className="viewer-bar">
              <span className="muted">
                {viewer.shot.label} · {viewer.shot.width}×{viewer.shot.height}
              </span>
              <div className="spacer" />
              {viewer.shot.source === "screen" && !!viewer.anns.length && (
                <button className="primary tiny" onClick={() => project(viewer.shot, viewer.anns)}>
                  在屏幕上显示
                </button>
              )}
              <button className="ghost tiny" onClick={() => setViewer(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {showWatch && watchState && (
        <WatchPanel
          settings={settings}
          state={watchState}
          onClose={() => setShowWatch(false)}
          onSaved={setSettings}
          onError={(m) => toast("error", m)}
        />
      )}

      {showSettings && (
        <SettingsDialog
          settings={settings}
          displays={displays}
          onClose={() => setShowSettings(false)}
          onSaved={(s, failed) => {
            setSettings(s);
            setShowSettings(false);
            if (failed.length) toast("warn", `快捷键注册失败（可能被占用）：${failed.join("、")}`);
            else toast("ok", "设置已保存");
          }}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

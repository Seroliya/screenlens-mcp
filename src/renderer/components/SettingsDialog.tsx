import { useEffect, useState } from "react";
import type { DisplayInfo, Settings } from "../../shared/types";
import { McpConnect } from "./McpConnect";

const PRESETS: { name: string; baseUrl: string; model: string }[] = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  { name: "LM Studio（本地）", baseUrl: "http://127.0.0.1:1234/v1", model: "" },
  { name: "Ollama（本地）", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5vl" },
  { name: "通义千问 DashScope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-max" },
  { name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k-vision-preview" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash" },
];

type Tab = "model" | "vision" | "hotkey" | "mcp";

export function SettingsDialog(props: {
  settings: Settings;
  displays: DisplayInfo[];
  onClose(): void;
  onSaved(s: Settings, failedHotkeys: string[]): void;
}) {
  const [tab, setTab] = useState<Tab>("model");
  const [d, setD] = useState<Settings>(props.settings);
  const [models, setModels] = useState<string[]>([]);
  const [modelErr, setModelErr] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [mcp, setMcp] = useState<{ script: string; exists: boolean } | null>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setD((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    window.api.app.mcpInfo().then(setMcp);
  }, []);

  const fetchModels = async () => {
    setModelErr("");
    // 用草稿里的地址/Key 拉取：先临时保存
    await window.api.settings.set({ baseUrl: d.baseUrl, apiKey: d.apiKey, proxy: d.proxy });
    try {
      setModels(await window.api.models());
    } catch (e) {
      setModelErr((e as Error).message);
    }
  };

  const save = async () => {
    const r = await window.api.settings.set(d);
    props.onSaved(r.settings, r.failedHotkeys);
  };

  const script = mcp?.script ?? "<ScreenLens>/mcp/screenlens-mcp.mjs";
  const fwd = script.replace(/\\/g, "/");
  const snippets = [
    { title: "Claude Code", hint: "终端执行：", code: `claude mcp add screenlens -s user -- node "${fwd}"` },
    {
      title: "Codex CLI",
      hint: "追加到 ~/.codex/config.toml：",
      code: `[mcp_servers.screenlens]\ncommand = "node"\nargs = ["${fwd}"]\nstartup_timeout_sec = 30`,
    },
    {
      title: "DSH / 其它 MCP 客户端（JSON 配置）",
      hint: "在客户端的 MCP 服务器配置中添加：",
      code: JSON.stringify({ mcpServers: { screenlens: { command: "node", args: [fwd] } } }, null, 2),
    },
  ];

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal settings">
        <div className="modal-head">
          <h3>设置</h3>
          <button className="ghost" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="tabs">
          {(
            [
              ["model", "模型 API"],
              ["vision", "截图与标注"],
              ["hotkey", "快捷键与窗口"],
              ["mcp", "Agent 接入 (MCP)"],
            ] as [Tab, string][]
          ).map(([k, n]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {n}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === "model" && (
            <>
              <div className="presets">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    className={`chip ${d.baseUrl === p.baseUrl ? "on" : ""}`}
                    onClick={() => setD((x) => ({ ...x, baseUrl: p.baseUrl, model: p.model || x.model }))}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <label className="field">
                <span>API 地址（OpenAI 兼容）</span>
                <input value={d.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
              </label>
              <label className="field">
                <span>API Key</span>
                <div className="row">
                  <input type={showKey ? "text" : "password"} value={d.apiKey} onChange={(e) => set("apiKey", e.target.value)} />
                  <button className="ghost" onClick={() => setShowKey(!showKey)}>
                    {showKey ? "隐藏" : "显示"}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>模型（必须支持图片输入）</span>
                <div className="row">
                  <input list="model-list" value={d.model} onChange={(e) => set("model", e.target.value)} />
                  <datalist id="model-list">
                    {models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <button className="ghost" onClick={fetchModels}>
                    获取列表
                  </button>
                </div>
                {modelErr && <small className="err">{modelErr}</small>}
                {!!models.length && <small className="muted">已获取 {models.length} 个模型，点输入框选择</small>}
              </label>
              <label className="field">
                <span>温度：{d.temperature}</span>
                <input type="range" min={0} max={1.5} step={0.1} value={d.temperature} onChange={(e) => set("temperature", +e.target.value)} />
              </label>
              <label className="field">
                <span>代理（留空跟随系统，例如 http://127.0.0.1:7900）</span>
                <input value={d.proxy} onChange={(e) => set("proxy", e.target.value)} />
              </label>
              <label className="field">
                <span>附加系统提示词</span>
                <textarea rows={3} value={d.extraPrompt} onChange={(e) => set("extraPrompt", e.target.value)} />
              </label>
            </>
          )}

          {tab === "vision" && (
            <>
              <label className="field">
                <span>截屏目标</span>
                <select
                  value={String(d.screenTarget)}
                  onChange={(e) => set("screenTarget", e.target.value === "cursor" ? "cursor" : +e.target.value)}
                >
                  <option value="cursor">光标所在的屏幕</option>
                  {props.displays.map((x, i) => (
                    <option key={x.id} value={x.id}>
                      屏幕 {i + 1}：{x.bounds.width}×{x.bounds.height}
                      {x.primary ? "（主屏）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={d.drawGrid} onChange={(e) => set("drawGrid", e.target.checked)} />
                发给模型的图片叠加坐标网格（显著提升标注精度，推荐开启）
              </label>
              <label className="check">
                <input type="checkbox" checked={d.autoCapture} onChange={(e) => set("autoCapture", e.target.checked)} />
                发送消息时自动截取当前来源
              </label>
              <label className="check">
                <input type="checkbox" checked={d.hideFromCapture} onChange={(e) => set("hideFromCapture", e.target.checked)} />
                本应用窗口不出现在截图中（关闭后截屏时会临时隐藏窗口）
              </label>
              <label className="check">
                <input type="checkbox" checked={d.recordAnnotations} onChange={(e) => set("recordAnnotations", e.target.checked)} />
                允许录屏捕获标注（推荐用于演示，不影响聊天窗口隐藏）
              </label>
              <small className="muted">
                录制时请选择录屏软件的“显示器/屏幕捕获”，仅录某个应用窗口通常不会包含独立的标注层。
                开启后，手动截图也可能包含标注；自动观察会在标注显示期间暂缓采样，清除或超时后恢复。
              </small>
              <label className="field">
                <span>发给模型的图片最长边：{d.maxImageSide}px</span>
                <input type="range" min={768} max={2560} step={64} value={d.maxImageSide} onChange={(e) => set("maxImageSide", +e.target.value)} />
              </label>
              <label className="field">
                <span>历史中最多携带图片数：{d.maxHistoryImages}</span>
                <input type="range" min={1} max={8} value={d.maxHistoryImages} onChange={(e) => set("maxHistoryImages", +e.target.value)} />
              </label>
              <label className="field">
                <span>屏幕标注自动消失：{d.overlaySeconds ? `${d.overlaySeconds} 秒` : "不自动消失（按 Esc 清除）"}</span>
                <input type="range" min={0} max={120} step={5} value={d.overlaySeconds} onChange={(e) => set("overlaySeconds", +e.target.value)} />
              </label>
            </>
          )}

          {tab === "hotkey" && (
            <>
              <label className="field">
                <span>截屏提问</span>
                <input value={d.hotkeyCapture} onChange={(e) => set("hotkeyCapture", e.target.value)} />
              </label>
              <label className="field">
                <span>显示 / 隐藏窗口</span>
                <input value={d.hotkeyToggle} onChange={(e) => set("hotkeyToggle", e.target.value)} />
              </label>
              <small className="muted">
                格式同 Electron Accelerator，如 Alt+Shift+S、CommandOrControl+Shift+Space。屏幕标注显示期间按 Esc 清除。
              </small>
              <label className="check">
                <input type="checkbox" checked={d.alwaysOnTop} onChange={(e) => set("alwaysOnTop", e.target.checked)} />
                窗口置顶
              </label>
            </>
          )}

          {tab === "mcp" && (
            <>
              <p className="muted">
                ScreenLens 以 stdio MCP 服务的形式向 Claude Code / Codex / DSH 等 Agent 提供工具：
                <code>screen_capture</code>、<code>camera_capture</code>、<code>list_displays</code>、<code>annotate</code>、
                <code>clear_annotations</code>、<code>list_cameras</code>、<code>watch_next</code> 等。Agent 里的模型能直接看到截图，并调用 annotate 在你屏幕上画框、圈、箭头、文字气泡。
                ScreenLens 未运行时，MCP 脚本会自动在后台启动它。
                Agent 每次使用摄像头前都会弹窗请你确认（可选"仅这一次"或"10 分钟内允许"），此限制无法关闭；托盘菜单可随时撤销授权。
              </p>
              {mcp && !mcp.exists && <div className="error-box">找不到 MCP 脚本：{script}</div>}
              <McpConnect />
              <details className="manual">
                <summary>手动配置（其它 MCP 客户端）</summary>
              {snippets.map((s) => (
                <div key={s.title} className="snippet">
                  <div className="snippet-head">
                    <b>{s.title}</b>
                    <button className="ghost tiny" onClick={() => navigator.clipboard.writeText(s.code)}>
                      复制
                    </button>
                  </div>
                  <small className="muted">{s.hint}</small>
                  <pre>{s.code}</pre>
                </div>
              ))}
              </details>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={props.onClose}>
            取消
          </button>
          <button className="primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

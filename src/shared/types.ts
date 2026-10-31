// 跨进程共享的类型定义（main / preload / renderer / overlay 共用）

/** 画面来源。android 目前仅占位，后续通过 adb/scrcpy 实现。 */
export type SourceKind = "screen" | "window" | "camera" | "android" | "upload";

/** 归一化坐标：0~1000，左上角为原点（与 Qwen-VL / DeepSeek-VL grounding 约定一致）。 */
export type Point = [number, number];
export type BBox = [number, number, number, number]; // x1, y1, x2, y2

export type AnnotationShape =
  | { type: "box"; bbox: BBox }
  | { type: "circle"; bbox: BBox }
  | { type: "arrow"; from: Point; to: Point }
  /** 文字气泡：at 为气泡中心，文字放在 label；可选 to 画尾巴指向目标 */
  | { type: "text"; at: Point; to?: Point };

export type Annotation = AnnotationShape & {
  label?: string;
  color?: string;
  /** 1-based，指向本轮用户消息中的第几张图；缺省为最后一张 */
  image?: number;
};

export interface ShotRef {
  id: string;
  source: SourceKind;
  width: number;
  height: number;
  /** 屏幕截图对应的 Electron display.id，用于把标注投影回真实屏幕 */
  displayId?: number;
  label?: string;
  /** 窗口截图在屏幕上的位置（DIP），用于把标注投影回屏幕 */
  screenRect?: { x: number; y: number; width: number; height: number };
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  shots?: ShotRef[];
  annotations?: Annotation[];
  /** 标注作用的截图 id（assistant 消息） */
  targetShotIds?: string[];
  model?: string;
  error?: string;
  createdAt: number;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** watch = 自动观察产生的对话 */
  kind?: "watch";
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[];
}

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 代理，如 http://127.0.0.1:7900；空 = 跟随系统 */
  proxy: string;
  /** 发送给模型的图片最长边 */
  maxImageSide: number;
  /** 历史中最多携带几张图片（含当前轮） */
  maxHistoryImages: number;
  /** 在发给模型的图上叠加坐标网格 */
  drawGrid: boolean;
  /** 发送消息时自动截取当前来源 */
  autoCapture: boolean;
  /** 屏幕标注自动消失秒数，0 = 不自动消失 */
  overlaySeconds: number;
  /** 让本应用窗口不出现在截图中（WDA_EXCLUDEFROMCAPTURE） */
  hideFromCapture: boolean;
  /** 允许录屏软件捕获屏幕标注（与主窗口隐藏独立） */
  recordAnnotations: boolean;
  /** 截屏目标：cursor = 光标所在屏幕，或指定 display.id */
  screenTarget: "cursor" | number;
  hotkeyCapture: string;
  hotkeyToggle: string;
  alwaysOnTop: boolean;
  extraPrompt: string;
  /** 首页不再提示一键接入 MCP */
  mcpPromptDismissed: boolean;

  // ---- 自动观察
  /** screen = 整屏（可配合前台程序过滤）；window = 锁定一个窗口 */
  watchScope: "screen" | "window";
  watchWindowId: string;
  watchWindowName: string;
  /** 整屏模式下只在白名单程序位于前台时观察 */
  watchFgFilter: boolean;
  /** 逗号分隔的进程名（不含 .exe） */
  watchFgAllow: string;
  /** 隐私黑名单：这些程序在前台时一律暂停 */
  watchBlocklist: string;
  /** 与上次发送的画面相比，变化格子占比达到多少 % 才发送 */
  watchSensitivity: number;
  /** 画面稳定多久（ms）才截图 */
  watchSettleMs: number;
  /** 两次发送最短间隔（秒） */
  watchMinInterval: number;
  /** 定时兜底（分钟），0 = 关闭 */
  watchPeriodicMin: number;
  /** 每小时最多发送次数 */
  watchHourlyCap: number;
  /** 变化上限 %：一次变化超过它视为切屏、不发送；0 = 关闭 */
  watchMaxChange: number;
  /** 告诉 AI 用户在做什么 */
  watchTask: string;
}

export interface WatchState {
  running: boolean;
  scopeLabel: string;
  /** 暂停原因（前台不在白名单、窗口最小化…） */
  paused: string | null;
  /** 相对上次发送画面的变化比例 0~1 */
  ratio: number;
  /** 当前阶段：等待变化 / 等待画面稳定 / 等待间隔 / AI 回复中 … */
  phase: string;
  sent: number;
  silent: number;
  spoke: number;
  lastSentAt: number;
  hourCount: number;
}

export interface WatchTrigger {
  shot: ShotRef;
  reason: string;
  scopeLabel: string;
}

export interface DisplayInfo {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  primary: boolean;
}

export interface CaptureResult {
  shot: ShotRef;
}

export interface ChatRequest {
  requestId: string;
  messages: unknown[]; // OpenAI 格式 messages（图片已转 data URL）
}

export interface ChatDelta {
  requestId: string;
  content?: string;
  reasoning?: string;
  done?: boolean;
  error?: string;
}

export interface OverlayPayload {
  annotations: Annotation[];
  /** 截图宽高比，用于 overlay 校验 */
  seconds: number;
}

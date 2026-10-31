import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Conversation, ConversationMeta, Settings } from "../shared/types";

const root = () => app.getPath("userData");
const convDir = () => path.join(root(), "conversations");
export const shotDir = () => path.join(root(), "shots");
const settingsFile = () => path.join(root(), "settings.json");

export function ensureDirs() {
  for (const d of [convDir(), shotDir()]) fs.mkdirSync(d, { recursive: true });
}

/** 读取项目根目录 / exe 同目录下的 .env.local，作为默认 API 配置（不入库）。 */
function readEnvLocal(): Record<string, string> {
  const candidates = [
    path.join(app.getAppPath(), ".env.local"),
    path.join(path.dirname(app.getPath("exe")), ".env.local"),
  ];
  for (const f of candidates) {
    try {
      const txt = fs.readFileSync(f, "utf8");
      const out: Record<string, string> = {};
      for (const line of txt.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      return out;
    } catch {
      /* 不存在 */
    }
  }
  return {};
}

export function defaultSettings(): Settings {
  const env = readEnvLocal();
  return {
    baseUrl: env.SCREENLENS_BASE_URL || "https://api.deepseek.com",
    apiKey: env.SCREENLENS_API_KEY || "",
    model: env.SCREENLENS_MODEL || "deepseek-flash",
    temperature: 0.4,
    proxy: env.SCREENLENS_PROXY || "",
    maxImageSide: 1600,
    maxHistoryImages: 3,
    drawGrid: true,
    autoCapture: true,
    // 默认 5 秒；需要挂久一点时由调用方显式传 seconds（MCP annotate / API 标注块）
    overlaySeconds: 5,
    hideFromCapture: true,
    recordAnnotations: true,
    screenTarget: "cursor",
    hotkeyCapture: "Alt+Shift+S",
    hotkeyToggle: "Alt+Shift+A",
    alwaysOnTop: false,
    extraPrompt: "",
    mcpPromptDismissed: false,
    watchScope: "window",
    watchWindowId: "",
    watchWindowName: "",
    watchFgFilter: true,
    watchFgAllow: "Code,Cursor,devenv,idea64,pycharm64,WindowsTerminal,pwsh,powershell,cmd,python,jupyter-lab",
    watchBlocklist: "KeePass,KeePassXC,1Password,Bitwarden,WeChat,Weixin,QQ",
    watchSensitivity: 5,
    watchSettleMs: 1500,
    watchMinInterval: 20,
    watchPeriodicMin: 5,
    watchHourlyCap: 30,
    watchMaxChange: 0,
    watchTask: "",
  };
}

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  const def = defaultSettings();
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Partial<Settings>;
    cached = { ...def, ...saved };
    // 未单独配置 key 时，回落到 .env.local
    if (!cached.apiKey) cached.apiKey = def.apiKey;
  } catch {
    cached = def;
  }
  return cached;
}

export function setSettings(patch: Partial<Settings>): Settings {
  cached = { ...getSettings(), ...patch };
  fs.writeFileSync(settingsFile(), JSON.stringify(cached, null, 2), "utf8");
  return cached;
}

const safeId = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法 id");
  return id;
};

export function listConversations(): ConversationMeta[] {
  const out: ConversationMeta[] = [];
  for (const f of fs.readdirSync(convDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(convDir(), f), "utf8")) as Conversation;
      out.push({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, pinned: c.pinned });
    } catch {
      /* 损坏文件跳过 */
    }
  }
  return out.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
}

export function getConversation(id: string): Conversation | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(convDir(), `${safeId(id)}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function saveConversation(c: Conversation) {
  const file = path.join(convDir(), `${safeId(c.id)}.json`);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c), "utf8");
  fs.renameSync(tmp, file);
}

export function deleteConversation(id: string) {
  const c = getConversation(id);
  // 一并删除该对话引用的截图
  for (const m of c?.messages ?? []) {
    for (const s of m.shots ?? []) {
      try {
        fs.unlinkSync(shotPath(s.id));
      } catch {
        /* ignore */
      }
    }
  }
  try {
    fs.unlinkSync(path.join(convDir(), `${safeId(id)}.json`));
  } catch {
    /* ignore */
  }
}

export const shotPath = (id: string) => path.join(shotDir(), `${safeId(id)}.jpg`);

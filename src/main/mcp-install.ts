import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

/**
 * 一键把 ScreenLens MCP 注册到 Agent 客户端。不依赖 electron，可在脚本中直接调用。
 * 启动命令统一用 Electron 可执行文件 + ELECTRON_RUN_AS_NODE=1 运行 MCP 脚本，
 * 这样用户机器上不需要额外的 node，也不依赖 PATH。
 */

export type McpClient = "dsh" | "codex" | "claude" | "workbuddy";

export interface McpLaunch {
  command: string;
  script: string;
}

export interface McpClientStatus {
  client: McpClient;
  name: string;
  /** 本机是否装了这个客户端 */
  detected: boolean;
  registered: boolean;
  configPath: string;
}

const home = os.homedir();
const DSH_FILE = path.join(home, ".dsh", "cordis.patch.yml");
const CODEX_FILE = path.join(home, ".codex", "config.toml");
const CLAUDE_FILE = path.join(home, ".claude.json");
const WORKBUDDY_FILE = path.join(home, ".workbuddy", "mcp.json");
const DSH_ID = "mcp-screenlens";

const read = (f: string) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

/** WorkBuddy 的配置是一整份 JSON，判断是否已接入得先解析 */
function workbuddyRegistered(): boolean {
  try {
    return !!JSON.parse(read(WORKBUDDY_FILE))?.mcpServers?.screenlens;
  } catch {
    return false;
  }
}

function backupAndWrite(file: string, content: string) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-screenlens-${Date.now()}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

export function mcpStatus(): McpClientStatus[] {
  return [
    {
      client: "dsh",
      name: "DeepSeek Harness (DSH)",
      detected: fs.existsSync(path.join(home, ".dsh")),
      registered: new RegExp(`id:\\s*${DSH_ID}\\b`).test(read(DSH_FILE)),
      configPath: DSH_FILE,
    },
    {
      client: "codex",
      name: "Codex CLI",
      detected: fs.existsSync(path.join(home, ".codex")),
      registered: /^\[mcp_servers\.screenlens\]/m.test(read(CODEX_FILE)),
      configPath: CODEX_FILE,
    },
    {
      client: "claude",
      name: "Claude Code",
      detected: fs.existsSync(CLAUDE_FILE) || fs.existsSync(path.join(home, ".claude")),
      registered: /"screenlens"\s*:/.test(read(CLAUDE_FILE)),
      configPath: CLAUDE_FILE,
    },
    {
      client: "workbuddy",
      name: "WorkBuddy",
      detected: fs.existsSync(path.join(home, ".workbuddy")),
      registered: workbuddyRegistered(),
      configPath: WORKBUDDY_FILE,
    },
  ];
}

// YAML 单引号字符串：只需把 ' 写成 ''
const yq = (s: string) => `'${s.replace(/'/g, "''")}'`;
// TOML 字面量字符串（不转义反斜杠）；含单引号时退回基本字符串
const tq = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);

function installDsh(l: McpLaunch) {
  const block = [
    "# ScreenLens：屏幕/摄像头视觉 + 屏幕标注（由 ScreenLens 一键接入写入）",
    "- insert:",
    `  - id: ${DSH_ID}`,
    "    name: '@deepseek-ai/dsh-mcp-client'",
    "    config:",
    "      serverName: screenlens",
    "      transport: stdio",
    `      command: ${yq(l.command)}`,
    "      args:",
    `      - ${yq(l.script)}`,
    `      cwd: ${yq(path.dirname(path.dirname(l.script)))}`,
    "      env:",
    "        ELECTRON_RUN_AS_NODE: '1'",
    "      toolCallTimeoutMs: 180000",
    "",
  ].join("\n");
  const cur = read(DSH_FILE);
  backupAndWrite(DSH_FILE, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + block);
}

function installCodex(l: McpLaunch) {
  const block = [
    "",
    "# ScreenLens：屏幕/摄像头视觉 + 屏幕标注（由 ScreenLens 一键接入写入）",
    "[mcp_servers.screenlens]",
    `command = ${tq(l.command)}`,
    `args = [${tq(l.script)}]`,
    "startup_timeout_sec = 40",
    "tool_timeout_sec = 180",
    "",
    "[mcp_servers.screenlens.env]",
    'ELECTRON_RUN_AS_NODE = "1"',
    "",
  ].join("\n");
  backupAndWrite(CODEX_FILE, read(CODEX_FILE).replace(/\s*$/, "\n") + block);
}

function installClaude(l: McpLaunch): Promise<void> {
  const json = JSON.stringify({ type: "stdio", command: l.command, args: [l.script], env: { ELECTRON_RUN_AS_NODE: "1" } });
  return new Promise((resolve, reject) => {
    // claude 在 Windows 上通常是 .cmd，需要经过 shell
    execFile("claude", ["mcp", "add-json", "-s", "user", "screenlens", json], { shell: process.platform === "win32", timeout: 30000 }, (err, _o, stderr) =>
      err ? reject(new Error(`claude mcp add-json 失败：${stderr || err.message}`)) : resolve(),
    );
  });
}

/**
 * WorkBuddy 的 MCP 配置是整份 JSON（{"mcpServers": {...}}），不能像 dsh / codex 那样
 * 往后追加文本块，所以这里读出来、只覆盖 screenlens 这一项、再写回：
 * 用户手写的其它 MCP 服务与字段都会保留。
 * 写入后还需要用户在「连接器管理 → 自定义连接器」里点一次「信任」，MCP 才会被加载。
 */
function installWorkbuddy(l: McpLaunch) {
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  const cur = read(WORKBUDDY_FILE);
  if (cur.trim()) {
    try {
      cfg = JSON.parse(cur);
    } catch {
      throw new Error(`${WORKBUDDY_FILE} 不是合法 JSON，请先修好再运行（原文件不会被改动）`);
    }
  }
  cfg.mcpServers = {
    ...(cfg.mcpServers ?? {}),
    screenlens: { command: l.command, args: [l.script], env: { ELECTRON_RUN_AS_NODE: "1" } },
  };
  backupAndWrite(WORKBUDDY_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}

export async function installMcp(client: McpClient, l: McpLaunch): Promise<McpClientStatus> {
  if (!fs.existsSync(l.script)) throw new Error(`找不到 MCP 脚本：${l.script}`);
  const before = mcpStatus().find((s) => s.client === client)!;
  if (!before.registered) {
    if (client === "dsh") installDsh(l);
    else if (client === "codex") installCodex(l);
    else if (client === "workbuddy") installWorkbuddy(l);
    else await installClaude(l);
  }
  return mcpStatus().find((s) => s.client === client)!;
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

/**
 * 一键把 ScreenLens MCP 注册到 Agent 客户端。不依赖 electron，可在脚本中直接调用。
 * 启动命令统一用 Electron 可执行文件 + ELECTRON_RUN_AS_NODE=1 运行 MCP 脚本，
 * 这样用户机器上不需要额外的 node，也不依赖 PATH。
 */

export type McpClient = "dsh" | "codex" | "claude";

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
const DSH_ID = "mcp-screenlens";

const read = (f: string) => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

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

export async function installMcp(client: McpClient, l: McpLaunch): Promise<McpClientStatus> {
  if (!fs.existsSync(l.script)) throw new Error(`找不到 MCP 脚本：${l.script}`);
  const before = mcpStatus().find((s) => s.client === client)!;
  if (!before.registered) {
    if (client === "dsh") installDsh(l);
    else if (client === "codex") installCodex(l);
    else await installClaude(l);
  }
  return mcpStatus().find((s) => s.client === client)!;
}

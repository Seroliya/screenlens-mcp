#!/usr/bin/env node
// ScreenLens MCP 服务（stdio，零依赖）。
// 让 Claude Code / Codex / DSH 等 Agent 里的模型看到屏幕/摄像头画面，并在屏幕上画框、圈、箭头。
// 实际工作由 ScreenLens 应用完成：本脚本通过 %APPDATA%/ScreenLens/bridge.json 找到本地控制端口；
// 应用未运行时自动在后台启动它。

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DATA =
  process.env.APPDATA ||
  (process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".config"));
const BRIDGE_FILE = join(APP_DATA, "ScreenLens", "bridge.json");
const VERSION = "0.1.0";

const log = (...a) => process.stderr.write(`[screenlens-mcp] ${a.join(" ")}\n`);

// ------------------------------------------------------------------ 与应用通信
function readBridge() {
  try {
    return JSON.parse(readFileSync(BRIDGE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function rpcOnce(info, method, params, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error), { remote: true });
  return j.result;
}

function electronExe() {
  if (process.env.SCREENLENS_ELECTRON) return process.env.SCREENLENS_ELECTRON;
  try {
    const rel = readFileSync(join(APP_ROOT, "node_modules", "electron", "path.txt"), "utf8").trim();
    return join(APP_ROOT, "node_modules", "electron", "dist", rel);
  } catch {
    return null;
  }
}

let launching = null;
async function launchApp() {
  if (launching) return launching;
  launching = (async () => {
    const exe = electronExe();
    if (!exe || !existsSync(exe)) throw new Error("ScreenLens 未运行，且找不到 Electron 可执行文件，请先手动启动 ScreenLens（npm start）");
    if (!existsSync(join(APP_ROOT, "dist", "main.js"))) throw new Error("ScreenLens 尚未构建，请先在项目目录执行 npm run build");
    log("启动 ScreenLens:", exe);
    // DSH / VS Code 等 Electron 宿主会把 ELECTRON_RUN_AS_NODE=1 传给子进程，必须去掉，否则 Electron 会以纯 Node 模式运行
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // --service：无 GUI 的服务模式（窗口永不显示，托盘只留设置/撤销/退出）
    const child = spawn(exe, [APP_ROOT, "--service"], { detached: true, stdio: "ignore", windowsHide: false, env });
    child.unref();
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      await new Promise((r) => setTimeout(r, 400));
      const info = readBridge();
      if (info) {
        try {
          await rpcOnce(info, "ping", {}, 2000);
          return info;
        } catch {
          /* 还没就绪 */
        }
      }
    }
    throw new Error("等待 ScreenLens 启动超时");
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

async function call(method, params = {}, timeoutMs = 30000) {
  let info = readBridge();
  if (info) {
    try {
      return await rpcOnce(info, method, params, timeoutMs);
    } catch (e) {
      if (e.remote) throw e; // 应用返回的业务错误
    }
  }
  info = await launchApp();
  return rpcOnce(info, method, params, timeoutMs);
}

// ------------------------------------------------------------------ 工具定义
const COORD_DOC =
  "坐标统一使用归一化坐标 0~1000：图片左上角 (0,0)，右下角 (1000,1000)，x 向右、y 向下，与像素尺寸无关。" +
  "返回的图片默认叠加了半透明橙色坐标网格（每 100 一条实线并标数字），用来精确读取坐标；网格不是画面内容。";

const annotationSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["box", "circle", "arrow", "text"],
      description: "box=矩形框，circle=圈出（用外接框 bbox），arrow=箭头，text=独立文字气泡（可多行，可选尾巴指向目标）",
    },
    bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "box/circle：[x1,y1,x2,y2]，0~1000" },
    from: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "arrow 起点 [x,y]，放在目标附近的空白处" },
    to: {
      type: "array", items: { type: "number" }, minItems: 2, maxItems: 2,
      description: "arrow 终点（指向的目标）[x,y]；text 可选：气泡尾巴指向的目标点",
    },
    at: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "text 气泡中心 [x,y]，放在空白处、不要盖住要看的内容；超出屏幕会自动内收" },
    text: { type: "string", description: "text 气泡正文：一两句话，可用 \\n 换行，自动折行，最多约 8 行" },
    label: { type: "string", description: "box/circle/arrow 的简短说明，建议不超过 12 个字" },
    color: { type: "string", description: "可选：red/orange/yellow/green/blue/purple 或 #hex" },
  },
  required: ["type"],
};

const TOOLS = [
  {
    name: "screen_capture",
    description:
      "截取用户的屏幕（整块显示器，默认是鼠标所在的屏幕），返回图片和 shot_id。在需要了解用户屏幕上有什么、或准备在屏幕上标注之前调用。" + COORD_DOC,
    inputSchema: {
      type: "object",
      properties: {
        display: {
          description: '要截取的显示器："cursor"（默认，鼠标所在屏幕）、"primary"，或 list_displays 返回的 index（从 1 开始）',
          anyOf: [{ type: "string", enum: ["cursor", "primary"] }, { type: "integer", minimum: 1 }],
        },
        grid: { type: "boolean", description: "是否叠加坐标网格，默认 true" },
        max_side: { type: "integer", description: "返回图片最长边像素，默认 1600", minimum: 512, maximum: 3840 },
      },
    },
  },
  {
    name: "camera_capture",
    description:
      "从用户的摄像头取一帧画面，返回图片和 shot_id。标注会画在 ScreenLens 窗口的摄像头面板上。\n" +
      "隐私保护：每次调用都会在用户电脑上弹出确认框，用户点\"允许\"后才会拍摄（可选\"仅这一次\"或\"10 分钟内允许\"）；" +
      "用户拒绝或 60 秒未确认会返回错误，此时不要重复调用，先在对话中向用户说明原因。" +
      "只在用户明确需要你看摄像头画面时调用，并在 reason 里写清楚用途。" +
      COORD_DOC,
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "为什么需要看摄像头（会显示在用户的确认框里），如\"查看你手里电路板的焊点\"" },
        device_id: { type: "string", description: "可选，摄像头设备 id（list_cameras 返回）；默认使用当前/默认摄像头" },
        grid: { type: "boolean", description: "是否叠加坐标网格，默认 true" },
        max_side: { type: "integer", minimum: 512, maximum: 3840 },
      },
    },
  },
  {
    name: "list_cameras",
    description: "列出可用的摄像头（id 与名称），用于 camera_capture 的 device_id。只列设备，不会打开摄像头。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_displays",
    description: "列出用户的显示器（index、分辨率、缩放、是否主屏）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "annotate",
    description:
      "在截图对应的位置画标注：屏幕截图会直接画在用户的真实屏幕上（透明置顶、可点穿，Esc 清除）；摄像头画面画在 ScreenLens 窗口内。" +
      "每次调用会替换上一次的屏幕标注。标注按顺序编号 ①②③，可在回复中用编号引用。" +
      "需要在屏幕上直接写一段话（解释、步骤、改法）时用 text 气泡，可配合 to 指向相关位置。" +
      "观察模式下标注不会阻塞 watch_next：标注区域会被忽略，其余区域照常检测变化。" +
      COORD_DOC,
    inputSchema: {
      type: "object",
      properties: {
        shot_id: { type: "string", description: "要标注的截图 id（screen_capture/camera_capture 返回）；默认最近一次截图" },
        annotations: { type: "array", items: annotationSchema, minItems: 1 },
        seconds: {
          type: "number",
          description:
            "标注显示多少秒后自动消失，默认 5 秒。内容多、用户要照着操作（多步骤说明）时自己传大一些（如 10~20）；" +
            "0 表示一直显示直到用户按 Esc。不要一律用默认值。",
        },
      },
      required: ["annotations"],
    },
  },
  {
    name: "clear_annotations",
    description: "清除屏幕上的所有标注。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_windows",
    description: "列出用户当前打开的窗口（id 与标题），用于 watch_next 的 window 参数。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "watch_next",
    description:
      "观察模式：阻塞等待用户屏幕（或锁定的窗口）出现下一次\"值得看\"的变化，然后返回那一刻的截图；在超时前没有变化则返回\"无变化\"。\n" +
      "变化检测在本地进行、不消耗 token：与最近返回过的画面比较（慢慢打字的变化会累积，切走再切回原画面不会重复返回），" +
      "等画面稳定后才截图；锁定窗口时切屏不影响；隐私黑名单程序在前台时自动暂停。长时间没有变化时会以\"定时检查\"返回，提示用户可能卡住了。\n" +
      "用法：循环调用。每次拿到截图后判断：发现报错、确定的 bug、或用户卡住时，用 annotate 标出位置（传入返回的 shot_id）并简短告诉用户；" +
      "没问题就不要说话，直接再次调用 watch_next。超时返回后也直接再次调用。第一次调用会开始观察并很快返回当前画面。" +
      "用户要求停止时调用 watch_stop。只在第一次调用（或要改变观察对象时）传 scope/window 等配置参数，之后不带参数调用即可保持同一会话。" +
      COORD_DOC,
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "string", description: "锁定观察的窗口：标题的一部分（如 \"Visual Studio Code\"）或 list_windows 返回的 id。推荐，切屏不受影响" },
        scope: { type: "string", enum: ["window", "screen"], description: "观察范围；给了 window 时默认 window，否则 screen（鼠标所在屏幕）" },
        fg_allow: { type: "string", description: "整屏模式下的前台程序白名单（进程名，逗号分隔，如 \"Code,WindowsTerminal\"），前台是其它程序时暂停计数" },
        sensitivity: { type: "number", description: "触发阈值：变化区域占比 %，默认 5（约等于新增两三行代码）" },
        settle_ms: { type: "integer", description: "画面稳定多久后截图，默认 1500" },
        min_interval: { type: "integer", description: "两次返回之间至少间隔多少秒，默认 10" },
        periodic_min: { type: "number", description: "多少分钟没有触发时做一次定时检查，默认 5；0 关闭" },
        timeout_sec: { type: "integer", description: "本次最多等待多少秒，默认 120（请小于你所在客户端的工具超时）", minimum: 5, maximum: 170 },
        include_image: { type: "boolean", description: "是否返回图片，默认 true；false 时只返回文字说明（需要时再 screen_capture）" },
        grid: { type: "boolean", description: "图片是否叠加坐标网格，默认 true" },
        max_side: { type: "integer", description: "返回图片最长边，默认 1280", minimum: 512, maximum: 3840 },
      },
    },
  },
  {
    name: "watch_stop",
    description: "停止 watch_next 开启的观察。",
    inputSchema: { type: "object", properties: {} },
  },
];

function watchStateText(st) {
  if (!st) return "";
  return `观察对象：${st.scopeLabel}；状态：${st.paused ? `暂停（${st.paused}）` : st.phase}；累计返回 ${st.sent} 次`;
}

function imageContent(dataUrl) {
  const m = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(dataUrl);
  return { type: "image", mimeType: m ? m[1] : "image/jpeg", data: m ? m[2] : dataUrl };
}

async function runTool(name, args = {}) {
  switch (name) {
    case "screen_capture":
    case "camera_capture": {
      // 摄像头要等用户确认（最长 60s）+ 取帧，超时必须更长，否则会被当成应用未运行而重发请求、再弹一次确认框
      const r = await call(name, args, name === "camera_capture" ? 110000 : 20000);
      const s = r.shot;
      const grid = args.grid !== false;
      const text =
        `shot_id: ${s.id}\n来源: ${s.source === "screen" ? `屏幕（${s.label}）` : `摄像头（${s.label}）`}\n` +
        `原始尺寸: ${s.width}×${s.height}，返回图片: ${r.image.width}×${r.image.height}\n` +
        (grid ? "图片叠加了 0~1000 归一化坐标网格。" : "图片未叠加网格。") +
        (r.virtual
          ? "\n注意：这是虚拟摄像头，画面可能不是真实场景。如需真实画面，用 list_cameras 找一个非虚拟设备并用 device_id 指定。"
          : "") +
        "调用 annotate 时使用 0~1000 归一化坐标，并传入此 shot_id。";
      return [{ type: "text", text }, imageContent(r.image.dataUrl)];
    }
    case "list_displays": {
      const r = await call("list_displays");
      return [{ type: "text", text: JSON.stringify(r, null, 2) }];
    }
    case "list_cameras": {
      const r = await call("list_cameras");
      const lines = r.map((c) => `${c.id}\t${c.label}${c.virtual ? "（虚拟设备，通常是不真实的画面）" : ""}`);
      return [{ type: "text", text: lines.join("\n") || "（没有检测到摄像头）" }];
    }
    case "annotate": {
      const r = await call("annotate", args);
      const where = r.target === "screen" ? "已画在用户屏幕上" : "已显示在 ScreenLens 窗口中";
      return [{ type: "text", text: `${where}：共 ${r.drawn} 处标注（shot_id ${r.shot_id}）。` }];
    }
    case "clear_annotations":
      await call("clear_annotations");
      return [{ type: "text", text: "已清除屏幕标注。" }];
    case "list_windows": {
      const r = await call("list_windows");
      return [{ type: "text", text: r.map((w) => `${w.id}\t${w.name}`).join("\n") || "（没有可用窗口）" }];
    }
    case "watch_next": {
      const timeout = Math.max(5, Math.min(170, Number(args.timeout_sec) || 120));
      const r = await call("watch_next", args, (timeout + 25) * 1000);
      const head = r.started ? "已开始观察。" : "";
      if (r.kind === "timeout") {
        return [{ type: "text", text: `${head}${r.waitedSec} 秒内没有值得注意的变化。${watchStateText(r.state)}。\n继续调用 watch_next（不带配置参数）即可接着观察。` }];
      }
      const s = r.trigger.shot;
      const text =
        `${head}触发：${r.trigger.reason}\nshot_id: ${s.id}（${r.trigger.scopeLabel}，原始 ${s.width}×${s.height}` +
        (r.image ? `，返回图片 ${r.image.width}×${r.image.height}）` : "）") +
        `\n${watchStateText(r.state)}\n` +
        "下一步：如果画面上有报错、确定的 bug、或用户卡住了，用 annotate（传此 shot_id）标出位置并简短提醒用户；否则不要说话，直接再次调用 watch_next。";
      return r.image ? [{ type: "text", text }, imageContent(r.image.dataUrl)] : [{ type: "text", text }];
    }
    case "watch_stop": {
      const r = await call("watch_stop");
      return [{ type: "text", text: r.stopped ? "已停止观察。" : "当前没有进行中的观察。" }];
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

// ------------------------------------------------------------------ JSON-RPC over stdio（按行分隔）
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // 通知，忽略
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "screenlens", version: VERSION },
        instructions:
          "ScreenLens 让你看到用户的屏幕/摄像头并在上面标注。用户问到屏幕上的东西时，先 screen_capture 看图；" +
          "需要指出位置时用 annotate 画框(box)/圈(circle)/箭头(arrow)/文字气泡(text)，坐标为 0~1000 归一化坐标。" +
          "用户希望你持续盯着屏幕（例如边写代码边帮看）时，循环调用 watch_next：它会等到画面出现值得看的变化才返回截图，没问题就保持沉默继续调用。",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call":
      try {
        const content = await runTool(params?.name, params?.arguments ?? {});
        return reply(id, { content, isError: false });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `错误：${e.message}` }], isError: true });
      }
    case "resources/list":
      return reply(id, { resources: [] });
    case "prompts/list":
      return reply(id, { prompts: [] });
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, "Parse error");
      continue;
    }
    handle(msg).catch((e) => msg.id != null && fail(msg.id, -32603, e.message));
  }
});
process.stdin.on("end", () => process.exit(0));

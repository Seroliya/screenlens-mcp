import { app } from "electron";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * 本地控制端口：只监听 127.0.0.1，需要 Bearer token。
 * 供 mcp/screenlens-mcp.mjs（stdio MCP 服务）调用，从而让 DSH / Codex / Claude Code 使用截屏与标注能力。
 */

export type BridgeHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

let server: http.Server | null = null;
export const bridgeFile = () => path.join(app.getPath("userData"), "bridge.json");

export function startBridge(handler: BridgeHandler): Promise<number> {
  const token = randomBytes(24).toString("hex");
  server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
    if (req.method !== "POST" || req.url !== "/rpc") return send(404, { error: "not found" });
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 5e6) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { method, params } = JSON.parse(raw || "{}");
        const result = await handler(String(method), params ?? {});
        send(200, { result });
      } catch (e) {
        send(200, { error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => {
      const port = (server!.address() as { port: number }).port;
      fs.writeFileSync(bridgeFile(), JSON.stringify({ port, token, pid: process.pid, startedAt: Date.now() }), "utf8");
      resolve(port);
    });
  });
}

export function stopBridge() {
  server?.close();
  try {
    const info = JSON.parse(fs.readFileSync(bridgeFile(), "utf8"));
    if (info.pid === process.pid) fs.unlinkSync(bridgeFile());
  } catch {
    /* ignore */
  }
}

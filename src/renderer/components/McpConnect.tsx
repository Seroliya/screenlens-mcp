import { useEffect, useState } from "react";

export interface McpClientStatus {
  client: "dsh" | "codex" | "claude";
  name: string;
  detected: boolean;
  registered: boolean;
  configPath: string;
}

export async function loadMcpStatus(): Promise<McpClientStatus[]> {
  return window.api.mcp.status();
}

/** 各 Agent 客户端的接入状态 + 一键接入按钮。设置页和首页提示卡共用。 */
export function McpConnect({ compact, onChange }: { compact?: boolean; onChange?(list: McpClientStatus[]): void }) {
  const [list, setList] = useState<McpClientStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const refresh = async () => {
    const l = await loadMcpStatus();
    setList(l);
    onChange?.(l);
  };
  useEffect(() => {
    refresh();
  }, []);

  const install = async (c: McpClientStatus["client"]) => {
    setBusy(c);
    setErr("");
    try {
      await window.api.mcp.install(c);
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(null);
    refresh();
  };

  const shown = compact ? list.filter((s) => s.detected) : list;
  return (
    <div className="mcp-connect">
      {shown.map((s) => (
        <div key={s.client} className="mcp-row">
          <div className="mcp-name">
            <b>{s.name}</b>
            {!compact && <small className="muted">{s.detected ? s.configPath : "未检测到该客户端"}</small>}
          </div>
          {s.registered ? (
            <span className="mcp-ok">✓ 已接入</span>
          ) : (
            <button className="primary tiny" disabled={!s.detected || !!busy} onClick={() => install(s.client)}>
              {busy === s.client ? "接入中…" : "一键接入"}
            </button>
          )}
        </div>
      ))}
      {err && <div className="error-box">{err}</div>}
      {!compact && <small className="muted">写入前会自动备份原配置（*.bak-screenlens-时间戳）。接入后在对应客户端新建会话即可使用 screenlens 工具。</small>}
    </div>
  );
}

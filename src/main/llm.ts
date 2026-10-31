import { net, session } from "electron";
import type { Settings } from "../shared/types";

/** OpenAI 兼容 /chat/completions 流式调用（DeepSeek、LM Studio、OpenRouter、Qwen 等均可）。 */

const controllers = new Map<string, AbortController>();

function endpoint(baseUrl: string) {
  const b = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  return /\/v\d+$/.test(b) ? `${b}/chat/completions` : `${b}/chat/completions`;
}

export async function applyProxy(proxy: string) {
  await session.defaultSession.setProxy(proxy ? { proxyRules: proxy } : { mode: "system" });
}

function headers(s: Settings): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (s.apiKey) h.Authorization = `Bearer ${s.apiKey}`;
  return h;
}

async function errorText(res: Response) {
  const t = await res.text().catch(() => "");
  try {
    const j = JSON.parse(t);
    return `HTTP ${res.status}: ${j.error?.message ?? j.message ?? t}`;
  } catch {
    return `HTTP ${res.status}: ${t.slice(0, 500)}`;
  }
}

export async function streamChat(
  s: Settings,
  requestId: string,
  messages: unknown[],
  emit: (d: { content?: string; reasoning?: string }) => void,
): Promise<void> {
  const ac = new AbortController();
  controllers.set(requestId, ac);
  try {
    const res = await net.fetch(endpoint(s.baseUrl), {
      method: "POST",
      headers: headers(s),
      body: JSON.stringify({ model: s.model, messages, stream: true, temperature: s.temperature }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(await errorText(res));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const j = JSON.parse(data);
          if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
          const d = j.choices?.[0]?.delta ?? {};
          const reasoning = d.reasoning_content ?? d.reasoning;
          if (reasoning || d.content) emit({ content: d.content || undefined, reasoning: reasoning || undefined });
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } finally {
    controllers.delete(requestId);
  }
}

export function abortChat(requestId: string) {
  controllers.get(requestId)?.abort();
}

/** 非流式补全（用于生成对话标题等小任务） */
export async function complete(s: Settings, messages: unknown[], maxTokens = 60): Promise<string> {
  const res = await net.fetch(endpoint(s.baseUrl), {
    method: "POST",
    headers: headers(s),
    body: JSON.stringify({ model: s.model, messages, stream: false, temperature: 0.3, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const j = await res.json();
  return String(j.choices?.[0]?.message?.content ?? "").trim();
}

export async function listModels(s: Settings): Promise<string[]> {
  const b = s.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  const res = await net.fetch(`${b}/models`, { headers: headers(s) });
  if (!res.ok) throw new Error(await errorText(res));
  const j = await res.json();
  return (j.data ?? []).map((m: { id: string }) => m.id);
}

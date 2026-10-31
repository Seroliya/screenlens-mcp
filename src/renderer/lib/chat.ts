import type { Annotation, ChatMessage, Settings, ShotRef } from "../../shared/types";
import { buildSystemPrompt } from "../../shared/prompt";
import { prepareImage } from "./image";

const SOURCE_NAME: Record<string, string> = { screen: "屏幕截图", window: "窗口截图", camera: "摄像头画面", upload: "图片", android: "安卓屏幕" };

/** 把对话转成 OpenAI 格式 messages。只有最近 maxHistoryImages 张图真正发送，更早的用文字占位。 */
export async function buildMessages(history: ChatMessage[], s: Settings): Promise<unknown[]> {
  const keep = new Set<string>();
  for (let i = history.length - 1; i >= 0 && keep.size < s.maxHistoryImages; i--) {
    const shots = history[i].shots ?? [];
    for (let j = shots.length - 1; j >= 0 && keep.size < s.maxHistoryImages; j--) keep.add(shots[j].id);
  }

  const out: unknown[] = [{ role: "system", content: buildSystemPrompt({ grid: s.drawGrid, extra: s.extraPrompt }) }];
  for (const m of history) {
    if (m.role === "assistant") {
      // 不回传 reasoning（DeepSeek 等要求）；出错的空回复用占位保持轮次交替
      out.push({ role: "assistant", content: m.content || (m.error ? "（上一轮回答失败）" : "（无内容）") });
      continue;
    }
    const shots = m.shots ?? [];
    if (!shots.length) {
      out.push({ role: "user", content: m.content });
      continue;
    }
    const parts: unknown[] = [];
    for (let j = 0; j < shots.length; j++) {
      const sh = shots[j];
      const name = `${SOURCE_NAME[sh.source] ?? "图片"}${sh.label ? `（${sh.label}）` : ""}`;
      if (keep.has(sh.id)) {
        const img = await prepareImage(sh.id, s.maxImageSide, s.drawGrid);
        parts.push({ type: "text", text: `[图片 ${j + 1}：${name}，原始尺寸 ${sh.width}×${sh.height}]` });
        parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
      } else {
        parts.push({ type: "text", text: `[图片 ${j + 1}：${name}（较早的截图，已省略）]` });
      }
    }
    parts.push({ type: "text", text: m.content.trim() || "请看这张图，说说画面里有什么值得注意的，并标注出来。" });
    out.push({ role: "user", content: parts });
  }
  return out;
}

/** 按 annotation.image（1-based，缺省最后一张）把标注分配到截图上 */
export function groupByShot(shots: ShotRef[], anns: Annotation[]): { shot: ShotRef; anns: Annotation[] }[] {
  if (!shots.length) return [];
  const map = new Map<string, { shot: ShotRef; anns: Annotation[] }>();
  for (const a of anns) {
    const idx = Math.min(shots.length, Math.max(1, Math.round(a.image ?? shots.length))) - 1;
    const shot = shots[idx];
    if (!map.has(shot.id)) map.set(shot.id, { shot, anns: [] });
    map.get(shot.id)!.anns.push(a);
  }
  return [...map.values()];
}

/** 把 \( \) \[ \] 形式的公式转成 remark-math 识别的 $ / $$ */
export function normalizeMath(md: string): string {
  return md
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, e) => `\n$$\n${e.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, e) => `$${e.trim()}$`);
}

export const uid = () => crypto.randomUUID();

import type { ChatMessage, Settings } from "../../shared/types";
import { buildWatchPrompt } from "../../shared/prompt";
import { splitAnnotations } from "../../shared/annotations";
import { prepareImage } from "./image";

/**
 * 观察模式每次都是单轮请求：系统提示词里带上\"之前说过的提醒\"摘要，
 * 只发这一张图，token 开销与对话长度无关。
 */
export async function buildWatchMessages(prior: ChatMessage[], user: ChatMessage, s: Settings, scope: string): Promise<unknown[]> {
  const previous = prior
    .filter((m) => m.role === "assistant" && m.content && !m.error)
    .slice(-4)
    .map((m) => {
      const t = splitAnnotations(m.content).text.replace(/\s+/g, " ").trim();
      const at = new Date(m.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      return `[${at}] ${t.slice(0, 160)}${t.length > 160 ? "…" : ""}`;
    });
  const shot = user.shots![0];
  const img = await prepareImage(shot.id, s.maxImageSide, s.drawGrid);
  return [
    { role: "system", content: buildWatchPrompt({ grid: s.drawGrid, extra: s.extraPrompt, task: s.watchTask, scope, previous }) },
    {
      role: "user",
      content: [
        { type: "text", text: `[自动截图：${scope}，原始尺寸 ${shot.width}×${shot.height}，时间 ${new Date(shot.createdAt).toLocaleTimeString("zh-CN")}]` },
        { type: "image_url", image_url: { url: img.dataUrl } },
        { type: "text", text: `触发原因：${user.content.replace(/^\[自动观察\]\s*/, "")}` },
      ],
    },
  ];
}

export function plainSnippet(md: string, n = 160) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
}

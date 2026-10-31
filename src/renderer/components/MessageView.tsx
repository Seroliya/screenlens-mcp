import { memo, useState } from "react";
import type { Annotation, ChatMessage, ShotRef } from "../../shared/types";
import { CIRCLED, colorOf, splitAnnotations } from "../../shared/annotations";
import { groupByShot } from "../lib/chat";
import { Markdown } from "./Markdown";
import { AnnotatedImage } from "./AnnotatedImage";

export interface MessageActions {
  openViewer(shot: ShotRef, anns: Annotation[]): void;
  project(shot: ShotRef, anns: Annotation[]): void;
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="ghost tiny"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
    >
      {ok ? "已复制" : "复制"}
    </button>
  );
}

export const UserMessage = memo(function UserMessage({ m, actions }: { m: ChatMessage; actions: MessageActions }) {
  return (
    <div className="msg user">
      <div className="bubble">
        {!!m.shots?.length && (
          <div className="shots">
            {m.shots.map((s) => (
              <div key={s.id} className="shot-thumb" title={s.label}>
                <AnnotatedImage shot={s} onClick={() => actions.openViewer(s, [])} />
                <span className="shot-tag">{s.label ?? s.source}</span>
              </div>
            ))}
          </div>
        )}
        {m.content && <div className="user-text">{m.content}</div>}
      </div>
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  m,
  shots,
  streaming,
  actions,
}: {
  m: ChatMessage;
  /** 本轮用户消息附带的截图（标注目标） */
  shots: ShotRef[];
  streaming: boolean;
  actions: MessageActions;
}) {
  const split = splitAnnotations(m.content);
  const anns = m.annotations ?? split.annotations;
  const groups = groupByShot(shots, anns);
  const thinking = streaming && !m.content;

  return (
    <div className="msg assistant">
      <div className="avatar">◉</div>
      <div className="body">
        {m.reasoning && (
          <details className="reasoning" open={streaming && !m.content}>
            <summary>{thinking ? "思考中…" : "思考过程"}</summary>
            <div className="reasoning-text">{m.reasoning}</div>
          </details>
        )}
        {split.text && <Markdown text={split.text} />}
        {thinking && !m.reasoning && (
          <div className="typing">
            <i />
            <i />
            <i />
          </div>
        )}
        {split.pending && <div className="hint-line">正在生成标注…</div>}
        {m.error && <div className="error-box">{m.error}</div>}

        {groups.map((g) => (
          <div className="ann-card" key={g.shot.id}>
            <AnnotatedImage shot={g.shot} anns={g.anns} className="ann-preview" onClick={() => actions.openViewer(g.shot, g.anns)} />
            <div className="ann-side">
              <div className="ann-list">
                {g.anns.map((a) => {
                  const i = anns.indexOf(a);
                  return (
                    <div key={i} className="ann-item">
                      <span className="ann-dot" style={{ background: colorOf(a, i) }}>
                        {CIRCLED[i] ?? i + 1}
                      </span>
                      <span>{a.label || { box: "框选", circle: "圈出", arrow: "指向", text: "说明" }[a.type]}</span>
                    </div>
                  );
                })}
              </div>
              <div className="ann-actions">
                {(g.shot.source === "screen" || (g.shot.source === "window" && g.shot.screenRect)) && (
                  <button className="primary tiny" onClick={() => actions.project(g.shot, g.anns)}>
                    在屏幕上显示
                  </button>
                )}
                <button className="ghost tiny" onClick={() => actions.openViewer(g.shot, g.anns)}>
                  放大查看
                </button>
              </div>
            </div>
          </div>
        ))}

        {!streaming && (m.content || m.error) && (
          <div className="msg-foot">
            {m.model && <span className="muted">{m.model}</span>}
            <CopyBtn text={split.text} />
          </div>
        )}
      </div>
    </div>
  );
});

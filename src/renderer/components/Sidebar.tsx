import { useMemo, useState } from "react";
import type { ConversationMeta } from "../../shared/types";

function groupLabel(t: number) {
  const d = new Date(t);
  const now = new Date();
  const day = 86400000;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= start) return "今天";
  if (t >= start - day) return "昨天";
  if (t >= start - 6 * day) return "最近 7 天";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function Sidebar(props: {
  list: ConversationMeta[];
  currentId: string | null;
  streamingIds: Set<string>;
  onSelect(id: string): void;
  onNew(): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
  onPin(id: string, pinned: boolean): void;
  onSettings(): void;
}) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const groups = useMemo(() => {
    const items = props.list.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));
    const out: { label: string; items: ConversationMeta[] }[] = [];
    for (const c of items) {
      const label = c.pinned ? "置顶" : groupLabel(c.updatedAt);
      let g = out.find((x) => x.label === label);
      if (!g) out.push((g = { label, items: [] }));
      g.items.push(c);
    }
    return out;
  }, [props.list, q]);

  const commit = (id: string) => {
    if (draft.trim()) props.onRename(id, draft.trim());
    setEditing(null);
  };

  return (
    <aside className="sidebar">
      <div className="side-top drag">
        <div className="brand">
          <span className="logo">◉</span> ScreenLens
        </div>
      </div>
      <button className="new-chat" onClick={props.onNew}>
        ＋ 新对话
      </button>
      <input className="search" placeholder="搜索对话" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="conv-list">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="conv-group">{g.label}</div>
            {g.items.map((c) => (
              <div
                key={c.id}
                className={`conv ${c.id === props.currentId ? "active" : ""}`}
                onClick={() => props.onSelect(c.id)}
                onDoubleClick={() => {
                  setEditing(c.id);
                  setDraft(c.title);
                }}
              >
                {editing === c.id ? (
                  <input
                    autoFocus
                    className="conv-edit"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commit(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit(c.id);
                      if (e.key === "Escape") setEditing(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="conv-title">
                      {props.streamingIds.has(c.id) && <span className="live-dot" />}
                      {c.title}
                    </span>
                    <span className="conv-ops" onClick={(e) => e.stopPropagation()}>
                      <button title={c.pinned ? "取消置顶" : "置顶"} onClick={() => props.onPin(c.id, !c.pinned)}>
                        {c.pinned ? "★" : "☆"}
                      </button>
                      <button
                        title="重命名"
                        onClick={() => {
                          setEditing(c.id);
                          setDraft(c.title);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        title="删除"
                        onClick={() => confirm(`删除对话「${c.title}」？截图也会一并删除。`) && props.onDelete(c.id)}
                      >
                        ✕
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
        {!props.list.length && <div className="muted pad">还没有对话</div>}
      </div>
      <button className="side-settings" onClick={props.onSettings}>
        ⚙ 设置
      </button>
    </aside>
  );
}

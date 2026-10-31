import { useEffect, useRef, useState } from "react";
import type { ShotRef } from "../../shared/types";
import { shotUrl } from "../lib/shot-url";

export function Composer(props: {
  pending: ShotRef[];
  busy: boolean;
  autoCapture: boolean;
  sourceLabel: string;
  focusSignal: number;
  onSend(text: string): void;
  onStop(): void;
  onCapture(): void;
  onFiles(files: File[]): void;
  onRemoveShot(id: string): void;
  onToggleAuto(v: boolean): void;
  onPreview(shot: ShotRef): void;
}) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    ta.current?.focus();
  }, [props.focusSignal]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(220, el.scrollHeight) + "px";
  }, [text]);

  const send = () => {
    if (props.busy) return;
    if (!text.trim() && !props.pending.length && !props.autoCapture) return;
    props.onSend(text);
    setText("");
  };

  return (
    <div
      className={`composer ${drag ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
        if (files.length) props.onFiles(files);
      }}
    >
      {!!props.pending.length && (
        <div className="pending">
          {props.pending.map((s) => (
            <div key={s.id} className="chip-shot">
              <img src={shotUrl(s.id)} onClick={() => props.onPreview(s)} />
              <span>{s.label ?? s.source}</span>
              <button onClick={() => props.onRemoveShot(s.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder={
          props.autoCapture && !props.pending.length
            ? `问点什么，发送时会自动截取${props.sourceLabel}…（Enter 发送，Shift+Enter 换行）`
            : "问点什么…（Enter 发送，Shift+Enter 换行）"
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (files.length) {
            e.preventDefault();
            props.onFiles(files);
          }
        }}
      />
      <div className="composer-bar">
        <button className="ghost" title={`立即截取${props.sourceLabel}`} onClick={props.onCapture}>
          ⛶ 截取{props.sourceLabel}
        </button>
        <button className="ghost" title="上传图片（也可粘贴或拖入）" onClick={() => fileRef.current?.click()}>
          🖼 图片
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length) props.onFiles(files);
            e.target.value = "";
          }}
        />
        <label className="toggle" title="发送时如果没有附图，自动截取当前来源">
          <input type="checkbox" checked={props.autoCapture} onChange={(e) => props.onToggleAuto(e.target.checked)} />
          <span>自动截取</span>
        </label>
        <div className="spacer" />
        {props.busy ? (
          <button className="stop" onClick={props.onStop}>
            ■ 停止
          </button>
        ) : (
          <button className="primary send" onClick={send}>
            发送 ↵
          </button>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Annotation, ShotRef } from "../../shared/types";
import { closeCamera, listCameras, openCamera } from "../lib/camera";
import { AnnotatedImage } from "./AnnotatedImage";

/** 摄像头实时预览；模型给出标注后冻结在被标注的那一帧上。 */
export function CameraPanel(props: {
  deviceId?: string;
  onDevice(id: string): void;
  frozen: { shot: ShotRef; anns: Annotation[] } | null;
  onUnfreeze(): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [err, setErr] = useState("");
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let alive = true;
    openCamera(props.deviceId)
      .then(async (s) => {
        if (!alive) return;
        setErr("");
        if (video.current) video.current.srcObject = s;
        setDevices(await listCameras());
      })
      .catch((e) => alive && setErr(`无法打开摄像头：${e.message}`));
    return () => {
      alive = false;
    };
  }, [props.deviceId]);

  // 离开摄像头模式时关闭设备
  useEffect(() => () => closeCamera(), []);

  return (
    <div className={`camera-panel ${collapsed ? "collapsed" : ""}`}>
      <div className="camera-bar">
        <span className="live-dot" /> 摄像头
        <select value={props.deviceId ?? ""} onChange={(e) => props.onDevice(e.target.value)}>
          <option value="">默认摄像头</option>
          {devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `摄像头 ${i + 1}`}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {props.frozen && (
          <button className="ghost tiny" onClick={props.onUnfreeze}>
            返回实时画面
          </button>
        )}
        <button className="ghost tiny" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? "展开" : "收起"}
        </button>
      </div>
      {!collapsed && (
        <div className="camera-view">
          {err && <div className="error-box">{err}</div>}
          <video ref={video} autoPlay muted playsInline style={{ display: props.frozen ? "none" : "block" }} />
          {props.frozen && <AnnotatedImage shot={props.frozen.shot} anns={props.frozen.anns} animate />}
        </div>
      )}
    </div>
  );
}

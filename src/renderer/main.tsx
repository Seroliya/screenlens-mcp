import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import "./styles.css";
import { ANNOTATION_CSS } from "../shared/draw";
import { prepareImage } from "./lib/image";
import { grabFrame, listCameras } from "./lib/camera";
import { App } from "./App";

const style = document.createElement("style");
style.textContent = ANNOTATION_CSS;
document.head.appendChild(style);

// 主进程（MCP 桥接）需要 canvas / getUserMedia 时回调到这里
window.api.serveRpc(async (method, p) => {
  switch (method) {
    case "image.prepare":
      return prepareImage(p.shotId, p.maxSide, p.grid);
    case "camera.grab":
      return grabFrame(p.deviceId, !!p.closeAfter);
    case "camera.list":
      return (await listCameras()).map((d, i) => ({ id: d.deviceId, label: d.label || `摄像头 ${i + 1}` }));
    default:
      throw new Error(`未知 RPC: ${method}`);
  }
});

createRoot(document.getElementById("root")!).render(<App />);

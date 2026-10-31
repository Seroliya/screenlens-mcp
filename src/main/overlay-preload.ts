import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("overlay", {
  onDraw: (fn: (anns: unknown) => void) => ipcRenderer.on("overlay:draw", (_e, a) => fn(a)),
  onClear: (fn: () => void) => ipcRenderer.on("overlay:clear", () => fn()),
});

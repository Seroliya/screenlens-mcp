import { contextBridge, ipcRenderer } from "electron";

const invoke = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
const on = (ch: string) => (fn: (payload: any) => void) => {
  const l = (_e: unknown, p: unknown) => fn(p);
  ipcRenderer.on(ch, l);
  return (): void => {
    ipcRenderer.removeListener(ch, l);
  };
};

const api = {
  settings: { get: invoke("settings:get"), set: invoke("settings:set") },
  conv: { list: invoke("conv:list"), get: invoke("conv:get"), save: invoke("conv:save"), delete: invoke("conv:delete") },
  displays: invoke("displays:list"),
  capture: { screen: invoke("capture:screen"), dataUrl: invoke("capture:dataUrl") },
  shotDataUrl: invoke("shot:dataUrl"),
  overlay: { show: invoke("overlay:show"), clear: invoke("overlay:clear") },
  chat: { start: invoke("chat:start"), abort: invoke("chat:abort"), title: invoke("chat:title"), onDelta: on("chat:delta") },
  models: invoke("models:list"),
  mcp: { status: invoke("mcp:status"), install: invoke("mcp:install") },
  watch: {
    start: invoke("watch:start"),
    stop: invoke("watch:stop"),
    state: invoke("watch:state"),
    windows: invoke("watch:windows"),
    result: invoke("watch:result"),
    onTrigger: on("watch:trigger"),
    onState: on("watch:state"),
    onAgentState: on("watch:agent-state"),
  },
  deleteShot: invoke("shot:delete"),
  app: {
    mcpInfo: invoke("app:mcpInfo"),
    openPath: invoke("app:openPath"),
    userData: invoke("app:userData"),
    hide: invoke("app:hide"),
  },
  on: {
    attachShot: on("app:attach-shot"),
    toast: on("app:toast"),
    overlayState: on("app:overlay-state"),
    showAnnotated: on("app:show-annotated"),
    agentActivity: on("app:agent-activity"),
    openConv: on("app:open-conv"),
  },
  /** 主进程 → 渲染进程 RPC */
  serveRpc(handler: (method: string, params: any) => Promise<unknown>) {
    ipcRenderer.on("rpc:req", async (_e, { id, method, params }) => {
      try {
        ipcRenderer.send("rpc:res", { id, result: await handler(method, params) });
      } catch (e) {
        ipcRenderer.send("rpc:res", { id, error: e instanceof Error ? e.message : String(e) });
      }
    });
  },
};

contextBridge.exposeInMainWorld("api", api);
export type Api = typeof api;

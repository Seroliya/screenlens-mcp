/** 摄像头流管理：预览面板与 MCP camera_capture 共用同一路流。 */

let stream: MediaStream | null = null;
let currentDevice: string | undefined;
let openedAt = 0;
const listeners = new Set<(s: MediaStream | null) => void>();

const emit = () => listeners.forEach((f) => f(stream));

export function onCameraChange(fn: (s: MediaStream | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput");
}

/**
 * 占位型虚拟摄像头：没有真实镜头输入时画面是无意义的黑底/占位图。
 * 只用于"默认别选它"的提示，不会禁用或删除任何设备。
 * OBS / Warudo / 采集卡等是用户有意接入的真实画面来源，算正常设备；
 * 名字里明确写着"虚拟摄像头 / Virtual Camera"但属于这些已知工具的，也放行。
 */
const PLACEHOLDER_CAM_RE = /虚拟摄像头|virtual camera|manycam|vcam|xsplit|snap camera|droidcam|iriun|epoccam|screen capture|屏幕捕获/i;
const KNOWN_REAL_SOURCE_RE = /\bobs\b|warudo|elgato|capture card|采集卡/i;

export const isVirtualCamera = (label: string) =>
  PLACEHOLDER_CAM_RE.test(label) && !KNOWN_REAL_SOURCE_RE.test(label);

/**
 * 没指定设备时优先选第一个非占位摄像头。
 * 全都像占位设备就退回默认设备（getUserMedia 不给 deviceId），不阻断使用。
 */
export async function pickDefaultCamera(): Promise<string | undefined> {
  try {
    const cams = await listCameras();
    const real = cams.find((c) => c.deviceId && !isVirtualCamera(c.label));
    return real?.deviceId;
  } catch {
    return undefined;
  }
}

export async function openCamera(deviceId?: string, allowSticky = true): Promise<MediaStream> {
  if (stream && stream.active && (!deviceId || deviceId === currentDevice)) return stream;
  closeCamera();
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  // 显式指定 > （允许时）用户在应用里选过的 > 跳过占位设备的默认选择
  const target = deviceId ?? (allowSticky ? currentDevice : undefined) ?? (await pickDefaultCamera());
  stream = await navigator.mediaDevices.getUserMedia({
    video: target ? { deviceId: { exact: target }, ...size } : size,
    audio: false,
  });
  currentDevice = stream.getVideoTracks()[0]?.getSettings().deviceId;
  openedAt = Date.now();
  emit();
  return stream;
}

/** 用户在应用里选择/切换摄像头（会记住，后续不指定 device_id 时沿用） */
export function setPreferredCamera(deviceId: string | undefined) {
  currentDevice = deviceId;
}

export function closeCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  emit();
}

/** closeAfter：摄像头原本没开（只为这次取帧打开）时，取完立即关闭，指示灯随之熄灭 */
export async function grabFrame(deviceId?: string, closeAfter = false) {
  const wasOpen = !!stream?.active;
  try {
    // 临时取帧（MCP 场景）不复用上次残留的设备，避免一直粘着占位摄像头
    return await grabFrameInner(deviceId, !closeAfter);
  } finally {
    if (closeAfter && !wasOpen) closeCamera();
  }
}

async function grabFrameInner(deviceId?: string, allowSticky = true) {
  const s = await openCamera(deviceId, allowSticky);
  // 刚打开的摄像头需要一点时间自动曝光
  const warm = 700 - (Date.now() - openedAt);
  if (warm > 0) await new Promise((r) => setTimeout(r, warm));
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = s;
  await video.play();
  for (let i = 0; i < 40 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 50));
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) throw new Error("摄像头没有输出画面");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
  video.pause();
  video.srcObject = null;
  const label = s.getVideoTracks()[0]?.label || "摄像头";
  return {
    dataUrl: canvas.toDataURL("image/jpeg", 0.9),
    width: w,
    height: h,
    label,
    virtual: isVirtualCamera(label),
  };
}

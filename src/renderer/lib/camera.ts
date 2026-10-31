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

export async function openCamera(deviceId?: string): Promise<MediaStream> {
  if (stream && stream.active && (!deviceId || deviceId === currentDevice)) return stream;
  closeCamera();
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId }, ...size } : size,
    audio: false,
  });
  currentDevice = stream.getVideoTracks()[0]?.getSettings().deviceId;
  openedAt = Date.now();
  emit();
  return stream;
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
    return await grabFrameInner(deviceId);
  } finally {
    if (closeAfter && !wasOpen) closeCamera();
  }
}

async function grabFrameInner(deviceId?: string) {
  const s = await openCamera(deviceId);
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
  return {
    dataUrl: canvas.toDataURL("image/jpeg", 0.9),
    width: w,
    height: h,
    label: s.getVideoTracks()[0]?.label || "摄像头",
  };
}

import type { Annotation } from "../shared/types";
import { drawAnnotations, ANNOTATION_CSS } from "../shared/draw";

declare global {
  interface Window {
    overlay: { onDraw(fn: (a: Annotation[]) => void): void; onClear(fn: () => void): void };
  }
}

const style = document.createElement("style");
style.textContent = ANNOTATION_CSS;
document.head.appendChild(style);

const svg = document.getElementById("svg") as unknown as SVGSVGElement;
const frame = document.getElementById("frame")!;
const hint = document.getElementById("hint")!;
let last: Annotation[] = [];

function render(anns: Annotation[], animate: boolean) {
  last = anns;
  const scale = Math.max(0.8, Math.min(1.6, window.innerWidth / 1600));
  drawAnnotations(svg, anns, { width: window.innerWidth, height: window.innerHeight, scale, animate });
}

window.overlay.onDraw((anns) => {
  frame.classList.add("on");
  hint.classList.add("on");
  setTimeout(() => frame.classList.remove("on"), 900);
  setTimeout(() => hint.classList.remove("on"), 2500);
  // 等窗口完成尺寸校正后再画
  requestAnimationFrame(() => render(anns, true));
});

window.overlay.onClear(() => {
  last = [];
  while (svg.firstChild) svg.removeChild(svg.firstChild);
});

window.addEventListener("resize", () => last.length && render(last, false));

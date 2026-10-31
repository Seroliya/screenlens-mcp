// 观察模式核心算法单测：node scripts/run-ts.mjs scripts/test-diff.ts
import { diffFrames, TW, TH, GW, GH, parseProcList, procIn, unionMask } from "../src/shared/frame-diff";
import { isSilent, SILENT_TOKEN } from "../src/shared/prompt";
import { mapFromDisplay, mapToDisplay } from "../src/main/watch-map";
import { parseAnnotations } from "../src/shared/annotations";
import { annotationMask, bubbleLayout, wrapText } from "../src/shared/annot-layout";

let fail = 0;
const ok = (cond: boolean, name: string) => {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fail++;
};

// 一张\"代码编辑器\"：深色背景 + 若干行浅色文字
function editor(lines: number, seed = 1) {
  const f = new Uint8Array(TW * TH).fill(30);
  let r = seed;
  for (let l = 0; l < lines; l++) {
    const y = 4 + l * 4;
    if (y >= TH - 1) break;
    const len = 20 + ((r = (r * 9301 + 49297) % 233280) % 110);
    for (let x = 8; x < 8 + len; x++) if ((x + l) % 3) f[y * TW + x] = 200;
  }
  return f;
}

const base = editor(10);
ok(diffFrames(base, base).cells === 0, "相同画面无变化");

// 光标闪烁：一个 2×3 的小块
const blink = base.slice();
for (let y = 50; y < 53; y++) for (let x = 60; x < 62; x++) blink[y * TW + x] = 255;
ok(diffFrames(base, blink).cells <= 1, "光标闪烁最多影响 1 格");

// 打字：多写 1 行 / 3 行，与\"上次发送\"比累计
const r1 = diffFrames(base, editor(11)).ratio;
const r3 = diffFrames(base, editor(13)).ratio;
ok(r1 > 0 && r1 < 0.05, `新增 1 行：${(r1 * 100).toFixed(1)}%（低于默认阈值 5%，不触发）`);
ok(r3 >= 0.05, `新增 3 行累计：${(r3 * 100).toFixed(1)}%（达到阈值，触发）`);

// 切到完全不同的界面
const other = new Uint8Array(TW * TH).fill(235);
const sw = diffFrames(base, other);
ok(sw.ratio > 0.9, `切屏：${(sw.ratio * 100).toFixed(0)}%`);

// 变化区域外接框
const box = base.slice();
for (let y = 70; y < 90; y++) for (let x = 100; x < 140; x++) box[y * TW + x] = 255;
const b = diffFrames(base, box).bbox!;
ok(b[0] === 625 && b[1] === 700 && b[2] === 875 && b[3] === 900, `变化区域 bbox = [${b.join(", ")}]`);
ok(GW * GH === 160, "16×10 网格");

// 进程名匹配
const allow = parseProcList("Code, WindowsTerminal，python.exe");
ok(procIn("Code", allow) && procIn("code.exe", allow) && procIn("Python", allow) && !procIn("chrome", allow), "进程名白名单匹配");

// 沉默判断
ok(isSilent(SILENT_TOKEN) && isSilent(` ${SILENT_TOKEN}\n`), "纯 [[SILENT]] 判为沉默");
ok(!isSilent(`第 12 行少了冒号 ${SILENT_TOKEN} 记得补上，否则会 SyntaxError`), "有实质内容不判为沉默");
ok(!isSilent("一切正常"), "没有标记不判为沉默");

// 窗口坐标 → 显示器坐标
const m = mapToDisplay([{ type: "box", bbox: [0, 0, 1000, 1000] }, { type: "arrow", from: [500, 500], to: [1000, 0] }] as any, { x: 100, y: 50, width: 800, height: 600 }, { x: 0, y: 0, width: 1000, height: 1000 }) as any[];
ok(JSON.stringify(m[0].bbox) === "[100,50,900,650]" && JSON.stringify(m[1].to) === "[900,50]" && JSON.stringify(m[1].from) === "[500,350]", "窗口标注映射到屏幕");

const back = mapFromDisplay(m, { x: 100, y: 50, width: 800, height: 600 }, { x: 0, y: 0, width: 1000, height: 1000 }) as any[];
ok(JSON.stringify(back[0].bbox) === "[0,0,1000,1000]" && JSON.stringify(back[1].to) === "[1000,0]", "显示器标注逆映射回窗口");
const mt = mapToDisplay([{ type: "text", at: [500, 500], to: [0, 0] }] as any, { x: 100, y: 50, width: 800, height: 600 }, { x: 0, y: 0, width: 1000, height: 1000 }) as any[];
ok(JSON.stringify(mt[0].at) === "[500,350]" && JSON.stringify(mt[0].to) === "[100,50]", "文字气泡的 at/to 也会映射");

// 文字气泡解析
const pa = parseAnnotations(JSON.stringify([
  { type: "text", at: [300, 200], text: "1. 先保存\n2. 再运行", to: [500, 600] },
  { type: "note", bbox: [100, 100, 300, 200], label: "备注" },
  { type: "bubble", at: [10, 10] },
])) as any[];
ok(pa.length === 2 && pa[0].type === "text" && pa[0].label === "1. 先保存\n2. 再运行" && JSON.stringify(pa[0].to) === "[500,600]", "text 气泡：正文保留编号，to 可选");
ok(pa[1].type === "text" && JSON.stringify(pa[1].at) === "[200,150]" && pa[1].to === undefined, "text 气泡：别名 note + 用 bbox 中心定位；空正文丢弃");

// 折行与气泡布局
const lines = wrapText("这是一段比较长的中文说明文字，用来测试自动折行是否正常工作", 15 * 8, 15);
ok(lines.length >= 3 && lines.every((l) => l.length <= 8), `中文按宽度折行：${lines.length} 行`);
const bl = bubbleLayout([995, 995], "靠近右下角的气泡", 1920, 1080);
ok(bl.x + bl.w <= 1920 - 4 && bl.y + bl.h <= 1080 - 4, "气泡超出画面时向内收");

// 标注掩码：只覆盖标注附近的格子，被忽略的格子不参与比较
const mask = annotationMask([{ type: "box", bbox: [625, 700, 875, 900] }] as any, 1600, 1000);
const masked = mask.reduce((s, v) => s + v, 0);
ok(masked > 0 && masked < GW * GH * 0.3, `box 标注掩码 ${masked} 格`);
ok(diffFrames(base, box, undefined, mask).cells === 0, "标注区域内的变化被忽略");
const outside = box.slice();
for (let y = 5; y < 25; y++) for (let x = 5; x < 45; x++) outside[y * TW + x] = 255;
ok(diffFrames(base, outside, undefined, mask).cells > 0, "标注区域外的变化照常检测");
ok(unionMask(null, mask) === mask && unionMask(null, null) === null, "掩码并集");

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);

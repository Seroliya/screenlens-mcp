/**
 * 观察模式提示词实测：两张画面各问一次真实模型
 *   A. 正常写代码（无问题） → 期望 [[SILENT]]
 *   B. 终端里有 Traceback  → 期望开口并标注
 * 运行：node scripts/run-ts.mjs scripts/test-watch-prompt.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWatchPrompt, isSilent } from "../src/shared/prompt";
import { splitAnnotations } from "../src/shared/annotations";

const OUT = resolve(".e2e");
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync)!;
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/).map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1], m![2]]),
);

const CODE_OK = `import requests
from bs4 import BeautifulSoup

def fetch_titles(url):
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    return [h.get_text(strip=True) for h in soup.select("h2.title")]

if __name__ == "__main__":
    for t in fetch_titles("https://example.com/news"):
        print(t)`;

const CODE_BUG = `import requests
from bs4 import BeautifulSoup

def fetch_titles(url):
    resp = requests.get(url, timeout=10)
    soup = BeautifulSoup(resp.text, "html.parser")
    titles = []
    for h in soup.select("h2.title"):
        titles.append(h.get_text(strip=True))
    return titels

if __name__ == "__main__":
    for t in fetch_titles("https://example.com/news"):
        print(t)`;

const TERM_OK = `PS D:\\study> python crawler.py\n`;
const TERM_BUG = `PS D:\\study> python crawler.py
Traceback (most recent call last):
  File "D:\\study\\crawler.py", line 13, in <module>
    for t in fetch_titles("https://example.com/news"):
  File "D:\\study\\crawler.py", line 10, in fetch_titles
    return titels
NameError: name 'titels' is not defined. Did you mean: 'titles'?
PS D:\\study> `;

function ide(code: string, term: string, name: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const lines = code.split("\n").map((l, i) => `<div><span class=n>${i + 1}</span>${esc(l) || " "}</div>`).join("");
  const html = `<!doctype html><meta charset=utf-8><style>
body{margin:0;background:#1e1e1e;color:#d4d4d4;font:15px Consolas,monospace;height:100vh;display:grid;grid-template-rows:34px 1fr 230px}
.tabs{background:#252526;color:#ccc;padding:8px 14px;font:13px 'Segoe UI'}.ed{padding:10px 0;white-space:pre;line-height:22px}
.n{display:inline-block;width:46px;color:#6e7681;text-align:right;margin-right:18px}.term{border-top:1px solid #444;background:#181818;padding:8px 14px;white-space:pre;line-height:20px;color:#ccc}
</style><div class=tabs>crawler.py — study — Visual Studio Code</div><div class=ed>${lines}</div><div class=term>TERMINAL\n${esc(term)}</div>`;
  const f = join(OUT, `${name}.html`);
  writeFileSync(f, html);
  const png = join(OUT, `${name}.png`);
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1280,800", `--screenshot=${png}`, pathToFileURL(f).href], { stdio: "ignore" });
  return png;
}

async function ask(png: string, reason: string, previous: string[] = []) {
  const res = await fetch(env.SCREENLENS_BASE_URL.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.SCREENLENS_API_KEY}` },
    body: JSON.stringify({
      model: env.SCREENLENS_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: buildWatchPrompt({ grid: false, task: "我在学 Python 写爬虫，出现报错、写法明显有问题、或者我卡住时提醒我", scope: "窗口「Visual Studio Code」", previous }) },
        { role: "user", content: [
          { type: "text", text: "[自动截图：窗口「Visual Studio Code」，原始尺寸 1280×800]" },
          { type: "image_url", image_url: { url: "data:image/png;base64," + readFileSync(png).toString("base64") } },
          { type: "text", text: `触发原因：${reason}` },
        ] },
      ],
    }),
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(j));
  return j.choices[0].message.content as string;
}

const a = await ask(ide(CODE_OK, TERM_OK, "watch-ok"), "画面变化约 12%；变化主要集中在区域 [62, 75, 625, 500]");
console.log(`A 正常代码 → ${isSilent(a) ? "沉默 ✓" : "开口 ✗"}\n   ${a.replace(/\s+/g, " ").slice(0, 200)}`);

const b = await ask(ide(CODE_BUG, TERM_BUG, "watch-bug"), "画面变化约 18%；变化主要集中在区域 [0, 700, 1000, 1000]");
const sb = splitAnnotations(b);
console.log(`\nB 有报错 → ${isSilent(b) ? "沉默 ✗" : "开口 ✓"}，标注 ${sb.annotations.length} 个\n   ${sb.text.replace(/\s+/g, " ").slice(0, 300)}\n   ${JSON.stringify(sb.annotations)}`);
writeFileSync(join(OUT, "watch-bug-answer.json"), JSON.stringify(sb.annotations));

// C. 同一个报错、已经提醒过 → 期望沉默（不重复唠叨）
const c = await ask(join(OUT, "watch-bug.png"), "定时检查：距上次查看已 5 分钟，期间只有零星变化", [`[10:02] ${sb.text.replace(/\s+/g, " ").slice(0, 160)}`]);
console.log(`\nC 同一报错已提醒过 → ${isSilent(c) ? "沉默" : "又提了一次"}\n   ${c.replace(/\s+/g, " ").slice(0, 200)}`);

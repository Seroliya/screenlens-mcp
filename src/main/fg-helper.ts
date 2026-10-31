import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 常驻 PowerShell 小进程：每 0.5s 输出一行 JSON，报告前台程序名，
 * 以及被跟踪窗口（HWND 逐行写在 target 文件里）的物理像素位置 / 是否最小化。
 * Electron 本身拿不到前台进程信息，这样做不需要任何原生依赖。
 * 应用内观察与 MCP 观察可能同时运行：引用计数启动/停止，每个使用者各自登记要跟踪的窗口。
 */

export type TargetInfo = { x: number; y: number; w: number; h: number; min: boolean; alive: true } | { alive: false };

export interface FgInfo {
  proc: string;
  pid: number;
  targets: Record<string, TargetInfo>;
  at: number;
}

const SCRIPT = String.raw`param([string]$TargetFile, [int]$ParentPid)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SLFg {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
}
"@
[void][SLFg]::SetProcessDPIAware()
$names = @{}
$n = 0
while ($true) {
  if (($n++ % 10) -eq 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  $h = [SLFg]::GetForegroundWindow()
  $procId = [uint32]0
  [void][SLFg]::GetWindowThreadProcessId($h, [ref]$procId)
  if (-not $names.ContainsKey($procId)) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $names[$procId] = if ($p) { $p.ProcessName } else { '' }
  }
  $t = @{}
  foreach ($raw in @(Get-Content -LiteralPath $TargetFile -ErrorAction SilentlyContinue)) {
    $raw = "$raw".Trim()
    if (-not $raw) { continue }
    $th = [IntPtr][int64]$raw
    if ([SLFg]::IsWindow($th)) {
      $r = New-Object SLFg+RECT
      [void][SLFg]::DwmGetWindowAttribute($th, 9, [ref]$r, 16)
      $t[$raw] = @{ x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T; min = [SLFg]::IsIconic($th); alive = $true }
    } else { $t[$raw] = @{ alive = $false } }
  }
  [Console]::Out.WriteLine((@{ proc = $names[$procId]; pid = $procId; targets = $t } | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 500
}
`;

const dir = path.join(os.tmpdir(), "screenlens");
const scriptFile = path.join(dir, "fg-helper-v2.ps1");
const targetFile = path.join(dir, `watch-target-${process.pid}.txt`);

let child: ChildProcess | null = null;
let latest: FgInfo | null = null;
let refs = 0;
const targets = new Map<string, string>(); // 使用者 → HWND

export function startFgHelper() {
  refs++;
  if (child || process.platform !== "win32") return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(scriptFile, SCRIPT, "utf8");
  child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile, targetFile, String(process.pid)],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (c: string) => {
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      try {
        const j = JSON.parse(line);
        latest = { proc: j.proc ?? "", pid: Number(j.pid) || 0, targets: j.targets ?? {}, at: Date.now() };
      } catch {
        /* ignore */
      }
    }
  });
  child.on("exit", () => {
    child = null;
  });
}

/** 登记 / 取消某个使用者要跟踪的窗口（HWND） */
export function setFgTarget(owner: string, hwnd: string | null) {
  if (hwnd) targets.set(owner, hwnd);
  else targets.delete(owner);
  try {
    const all = [...new Set(targets.values())];
    if (all.length) fs.writeFileSync(targetFile, all.join("\n"), "utf8");
    else fs.rmSync(targetFile, { force: true });
  } catch {
    /* ignore */
  }
}

/** 最新信息；超过 3s 未更新视为不可用 */
export function getFg(): FgInfo | null {
  return latest && Date.now() - latest.at < 3000 ? latest : null;
}

export function stopFgHelper(owner: string) {
  setFgTarget(owner, null);
  refs = Math.max(0, refs - 1);
  if (refs > 0) return;
  child?.kill();
  child = null;
  latest = null;
}

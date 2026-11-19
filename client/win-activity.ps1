# 每隔 N 毫秒输出一行 JSON：前台窗口所属进程名、窗口标题、键鼠空闲毫秒数
# 进程名和标题都用 base64(UTF-8) 输出：控制台代码页不是 UTF-8 时，直接输出非 ASCII 字符会变成 ????
# 只在本机运行，由 Buddy Pet 客户端启动；标题只用于本地分类，不会上传。
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BuddyWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO l);
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static uint IdleMs() {
    var l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(l);
    if (!GetLastInputInfo(ref l)) return 0;
    return unchecked((uint)Environment.TickCount - l.dwTime);
  }
}
"@

$interval = 2000
if ($args.Count -gt 0) { $interval = [int]$args[0] }

while ($true) {
  $h = [BuddyWin]::GetForegroundWindow()
  $title = [BuddyWin]::Title($h)
  $procId = [BuddyWin]::Pid($h)
  $name = ''
  if ($procId -ne 0) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p) { $name = $p.ProcessName }
  }
  $idle = [BuddyWin]::IdleMs()
  $n64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($name))
  $t64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($title))
  [Console]::Out.WriteLine('{"proc64":"' + $n64 + '","title64":"' + $t64 + '","idleMs":' + $idle + '}')
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $interval
}

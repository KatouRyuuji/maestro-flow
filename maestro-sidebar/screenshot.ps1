Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32B {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$p = Get-Process maestro-sidebar -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'NO WINDOW'; exit 1 }
$hwnd = $p.MainWindowHandle
# 移到 (0,0) 并置顶（TOPMOST = -1），然后显示
$HWND_TOPMOST = [IntPtr](-1)
[Win32B]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
[Win32B]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
Start-Sleep -Milliseconds 1000
$r = New-Object Win32B+RECT
[Win32B]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
Write-Output "WINDOW: $($r.Left),$($r.Top) ${w}x${h}"
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save('D:/maestro2/maestro-sidebar/screenshot.png', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output 'SAVED'
# 恢复非置顶
[Win32B]::SetWindowPos($hwnd, [IntPtr](0), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null

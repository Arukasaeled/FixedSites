param([string]$WindowHandle, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CanvasCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
}
'@
[CanvasCapture]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$target = [IntPtr][Convert]::ToInt64($WindowHandle.Substring(2),16)
$rect = New-Object CanvasCapture+Rect
if (-not [CanvasCapture]::GetWindowRect($target,[ref]$rect)) { throw 'Cannot locate owned test window.' }
$image = New-Object System.Drawing.Bitmap ($rect.Right-$rect.Left),($rect.Bottom-$rect.Top)
$graphics = [System.Drawing.Graphics]::FromImage($image)
try {
  $dc=$graphics.GetHdc()
  try { if (-not [CanvasCapture]::PrintWindow($target,$dc,2)) { throw 'Owned window capture failed.' } }
  finally { $graphics.ReleaseHdc($dc) }
  $image.Save($OutputPath,[System.Drawing.Imaging.ImageFormat]::Png)
}
finally { $graphics.Dispose(); $image.Dispose() }

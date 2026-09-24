// Tiny Win32 helper for Souty.
//   win-helper.exe capture        -> prints the foreground window handle
//   win-helper.exe focus <hwnd>   -> gives keyboard focus back to <hwnd>
//   win-helper.exe paste <hwnd>   -> refocuses <hwnd> and sends Ctrl+V (virtual keys, layout independent)
// Build: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /out:win-helper.exe win-helper.cs
using System;
using System.Runtime.InteropServices;
using System.Threading;

class WinHelper
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    const byte VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SHIFT = 0x10, VK_V = 0x56;
    const uint KEYUP = 0x2;

    static int Main(string[] args)
    {
        if (args.Length == 0) return 1;

        if (args[0] == "capture")
        {
            Console.Write(GetForegroundWindow().ToInt64());
            return 0;
        }

        if (args[0] == "focus")
        {
            Refocus(args);
            return 0;
        }

        if (args[0] == "paste")
        {
            Refocus(args);
            // Release modifiers the user may still be holding from the hotkey
            keybd_event(VK_SHIFT, 0, KEYUP, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);

            keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
            keybd_event(VK_V, 0, 0, UIntPtr.Zero);
            keybd_event(VK_V, 0, KEYUP, UIntPtr.Zero);
            keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
            return 0;
        }

        return 1;
    }

    static void Refocus(string[] args)
    {
        long h;
        if (args.Length < 2 || !long.TryParse(args[1], out h) || h == 0) return;
        IntPtr target = new IntPtr(h);
        if (!IsWindow(target) || GetForegroundWindow() == target) return;
        // Alt tap lets a background process take foreground rights
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);
        SetForegroundWindow(target);
        Thread.Sleep(60);
    }
}

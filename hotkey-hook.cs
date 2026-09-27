// Low-level keyboard hook for Souty.
// Prints HOTKEY_TRIGGERED on Ctrl+Space (read by main.js) and swallows that Space so the Windows IME doesn't toggle.
// Build: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /out:hotkey-hook.exe hotkey-hook.cs
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

class HotkeyHook
{
    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc fn, IntPtr hMod, uint threadId);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    const int WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
    const int VK_SPACE = 0x20, VK_CONTROL = 0x11, VK_SHIFT = 0x10, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RWIN = 0x5C;

    static LowLevelKeyboardProc proc = Hook; // kept in a field so the GC never collects the callback
    static bool swallowing; // Space down was swallowed, so swallow its key-up too

    static IntPtr Hook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && Marshal.ReadInt32(lParam) == VK_SPACE)
        {
            int msg = wParam.ToInt32();
            if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
            {
                // Ctrl+Space only: Ctrl+Shift+Space is left to main.js's globalShortcut
                if (Down(VK_CONTROL) && !Down(VK_SHIFT) && !Down(VK_MENU) && !Down(VK_LWIN) && !Down(VK_RWIN))
                {
                    if (!swallowing) { Console.WriteLine("HOTKEY_TRIGGERED"); Console.Out.Flush(); } // auto-repeat fires once
                    swallowing = true;
                    return (IntPtr)1;
                }
            }
            else if ((msg == WM_KEYUP || msg == WM_SYSKEYUP) && swallowing)
            {
                swallowing = false;
                return (IntPtr)1;
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    static int Main()
    {
        IntPtr hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName), 0);
        if (hook == IntPtr.Zero) return 1;
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { } // the hook only runs while this thread pumps messages
        return 0;
    }
}

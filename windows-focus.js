const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const nativeWindowType = String.raw`
using System;
using System.Runtime.InteropServices;

public static class NovaPuraWindowFocus
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint sourceThreadId, uint targetThreadId, bool attach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    public static void RestoreForeground(long rawHandle)
    {
        IntPtr hWnd = new IntPtr(rawHandle);
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return;

        uint ignoredProcessId;
        uint currentThreadId = GetCurrentThreadId();
        uint targetThreadId = GetWindowThreadProcessId(hWnd, out ignoredProcessId);
        IntPtr currentForeground = GetForegroundWindow();
        uint foregroundThreadId = currentForeground == IntPtr.Zero
            ? 0
            : GetWindowThreadProcessId(currentForeground, out ignoredProcessId);

        if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
            AttachThreadInput(currentThreadId, foregroundThreadId, true);
        if (targetThreadId != 0 && targetThreadId != currentThreadId)
            AttachThreadInput(currentThreadId, targetThreadId, true);
        try
        {
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        }
        finally
        {
            if (targetThreadId != 0 && targetThreadId != currentThreadId)
                AttachThreadInput(currentThreadId, targetThreadId, false);
            if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
                AttachThreadInput(currentThreadId, foregroundThreadId, false);
        }
    }
}`;

async function runPowerShell(command) {
  return execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { windowsHide: true, timeout: 10000 }
  );
}

async function captureForegroundWindow() {
  const command = `Add-Type -TypeDefinition @'\n${nativeWindowType}\n'@\n[Console]::Write([NovaPuraWindowFocus]::GetForegroundWindow().ToInt64())`;
  const { stdout } = await runPowerShell(command);
  return stdout.trim();
}

async function restoreForegroundWindow(windowHandle) {
  if (!/^\d+$/.test(String(windowHandle || ''))) return;
  const command = `Add-Type -TypeDefinition @'\n${nativeWindowType}\n'@\n[NovaPuraWindowFocus]::RestoreForeground([Int64]${windowHandle})`;
  await runPowerShell(command);
}

function createBackgroundBrowserLauncher({
  platform = process.platform,
  captureForegroundWindow: capture = captureForegroundWindow,
  restoreForegroundWindow: restore = restoreForegroundWindow
} = {}) {
  let launchQueue = Promise.resolve();

  return function launchBrowserInBackground(browserLauncher, launchOptions) {
    if (platform !== 'win32') return browserLauncher(launchOptions);

    const queuedLaunch = launchQueue.then(async () => {
      let foregroundWindow = null;
      try {
        foregroundWindow = await capture().catch(() => null);
        const browser = await browserLauncher(launchOptions);
        return browser;
      } finally {
        if (foregroundWindow !== null) {
          await restore(foregroundWindow).catch(() => {});
        }
      }
    });
    launchQueue = queuedLaunch.catch(() => {});
    return queuedLaunch;
  };
}

const launchBrowserInBackground = createBackgroundBrowserLauncher();

module.exports = {
  createBackgroundBrowserLauncher,
  launchBrowserInBackground
};

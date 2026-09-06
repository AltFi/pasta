import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { RuntimeClient } from "./runtimeClient";
import { runInjector } from "./injector";
import { initConsoleWindow, revealConsole, forwardLog, closeConsoleWindow } from "./consoleWindow";
import { startHttpBridge, stopHttpBridge } from "./httpBridge";
import { IpcChannel, LogEntry, LogLevel, PipeSendResult } from "../shared/ipc";

const VALID_PROCESS_NAME = /^[\w.\-]+\.exe$/i;

function isProcessRunning(processName: string): Promise<boolean> {
  if (!VALID_PROCESS_NAME.test(processName.trim())) return Promise.resolve(false);

  return new Promise((resolve) => {
    // execFile (not exec) with an argv array — no shell interpolation, so the
    // process name can't be used to inject extra tasklist arguments even
    // though we already validate it against VALID_PROCESS_NAME above.
    execFile(
      "tasklist.exe",
      ["/FI", `IMAGENAME eq ${processName}`, "/NH", "/FO", "CSV"],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(stdout.toLowerCase().includes(processName.toLowerCase()));
      }
    );
  });
}

// Single instance lock — a second launch just focuses the existing window
// instead of spawning a competing pipe client.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const runtimeClient = new RuntimeClient();

function getAppIconPath(): string {
  // electron-builder's rcedit-based icon embedding is skipped for this build
  // (signAndEditExecutable: false — see package.json comment context), so
  // the packaged .exe keeps Electron's default file icon. Setting the icon
  // here still gives the *running* window/taskbar the real PulseExecutor icon.
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "..", "..", "build", "icon.ico");
}

function sendLog(level: LogLevel, message: string): void {
  const entry: LogEntry = { level, message, timestamp: Date.now() };
  mainWindow?.webContents.send(IpcChannel.Log, entry);
  forwardLog(entry);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 880,
    minHeight: 640,
    frame: false,
    show: false,
    // Transparent so the rounded corners drawn in CSS on .shell are actually
    // visible (an opaque backgroundColor would just fill in the rounded-off
    // pixels with the same color, making the rounding invisible).
    transparent: true,
    backgroundColor: "#00000000",
    titleBarStyle: "hidden",
    roundedCorners: true,
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      // eslint-disable-next-line no-console
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }

  const sendWindowState = () => {
    if (!mainWindow) return;
    mainWindow.webContents.send(IpcChannel.WindowState, {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
    });
  };
  mainWindow.on("maximize", sendWindowState);
  mainWindow.on("unmaximize", sendWindowState);
  mainWindow.on("enter-full-screen", sendWindowState);
  mainWindow.on("leave-full-screen", sendWindowState);

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
    // The console window is a separate, non-taskbar utility window — if we
    // don't close it explicitly here, "window-all-closed" below never fires
    // (Electron waits for *every* BrowserWindow to close), so the app would
    // linger as an invisible background process after the user closes the
    // main window.
    closeConsoleWindow();
  });
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  initConsoleWindow();
  startHttpBridge();
  sendLog("info", "HTTP bridge listening on 127.0.0.1:6970");

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  runtimeClient.disconnect();
  stopHttpBridge();
  closeConsoleWindow();
  if (process.platform !== "darwin") app.quit();
});

// ---------- Window controls ----------

ipcMain.on(IpcChannel.WindowMinimize, () => mainWindow?.minimize());

ipcMain.on(IpcChannel.WindowToggleMaximize, () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on(IpcChannel.WindowClose, () => mainWindow?.close());

ipcMain.on(IpcChannel.WindowToggleFullscreen, () => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ---------- Engine communication ----------
//
// "Connected" here means "the last connectivity check or script send got a
// real reply from the engine" — Pulse's TcpServer doesn't hold a
// persistent session open (see runtimeClient.ts), so this status reflects
// last-known reachability, not an open socket.

runtimeClient.on("status", (status) => {
  mainWindow?.webContents.send(IpcChannel.PipeStatus, status);
});

ipcMain.handle(IpcChannel.PipeConnect, async () => {
  try {
    const status = await runtimeClient.connect();
    sendLog("success", "Engine reachable");
    return status;
  } catch (err) {
    sendLog("error", err instanceof Error ? err.message : String(err));
    return runtimeClient.getStatus();
  }
});

ipcMain.handle(IpcChannel.PipeDisconnect, async () => {
  const status = runtimeClient.disconnect();
  sendLog("info", "Disconnected");
  return status;
});

ipcMain.handle(IpcChannel.PipeStatus, () => runtimeClient.getStatus());

ipcMain.handle(IpcChannel.PipeSendScript, async (_e, code: string): Promise<PipeSendResult> => {
  try {
    const response = await runtimeClient.sendScript(code);
    if (response.ok) {
      sendLog("success", `Script sent (${Buffer.byteLength(code, "utf-8")} bytes) — ${response.text}`);
      return { ok: true, responseText: response.text };
    }
    sendLog("error", response.text);
    return { ok: false, error: response.text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog("error", message);
    return { ok: false, error: message };
  }
});

// ---------- Renderer-originated log lines (forwarded to the console window) ----------

const VALID_LOG_LEVELS: LogLevel[] = ["info", "success", "warn", "error"];
ipcMain.on(IpcChannel.LogFromRenderer, (_e, payload: { level: LogLevel; message: string }) => {
  if (!payload || !VALID_LOG_LEVELS.includes(payload.level) || typeof payload.message !== "string") return;
  sendLog(payload.level, payload.message.slice(0, 2000));
});

// ---------- Process activity check ----------

ipcMain.handle(IpcChannel.ProcessCheck, (_e, processName: string) => isProcessRunning(processName));

// ---------- Injector ----------

ipcMain.handle(IpcChannel.InjectorRun, async (_e, processName: string) => {
  revealConsole(mainWindow);
  sendLog("info", `Injecting into process "${processName}"...`);
  const result = await runInjector(processName);
  sendLog(result.success ? "success" : "error", result.success ? "Injection successful" : "Injection failed");
  if (result.log) {
    for (const line of result.log.split(/\r?\n/).filter(Boolean)) {
      sendLog(result.success ? "info" : "warn", line);
    }
  }
  return result;
});

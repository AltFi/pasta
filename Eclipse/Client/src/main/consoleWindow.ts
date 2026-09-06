import { BrowserWindow, ipcMain, screen } from "electron";
import * as path from "node:path";
import { IpcChannel, LogEntry, ConsoleWindowState } from "../shared/ipc";

const DEFAULT_WIDTH = 440;
const COLLAPSED_HEIGHT = 40;
const DEFAULT_EXPANDED_HEIGHT = 280;

let win: BrowserWindow | null = null;
let collapsed = true;
let expandedHeight = DEFAULT_EXPANDED_HEIGHT;
let animTimer: NodeJS.Timeout | null = null;

// The real bug this fixes: revealConsole() creates the console
// BrowserWindow and calls loadFile(), which is asynchronous — the page
// (and console.ts's window.pulse.onLog listener) isn't ready the instant
// createWindow() returns. Callers (main.ts's InjectorRun handler) log
// immediately after revealConsole(), so on the very first inject those
// log lines get sent via webContents.send() before anything on the other
// end is listening. Electron does not queue sends for a not-yet-ready
// renderer — they're just gone. Every log is now kept here regardless of
// whether the window exists/is ready yet, and handed to the renderer as
// a one-time backlog once it explicitly signals it's actually listening.
const HISTORY_LIMIT = 500;
const history: LogEntry[] = [];

function getPreloadPath(): string {
  return path.join(__dirname, "..", "preload", "preload.js");
}

function getConsoleHtmlPath(): string {
  return path.join(__dirname, "..", "renderer", "console.html");
}

function animateHeight(target: number, durationMs = 220): void {
  if (!win || win.isDestroyed()) return;
  if (animTimer) clearInterval(animTimer);

  const [w, startH] = win.getSize();
  const start = Date.now();

  animTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      if (animTimer) clearInterval(animTimer);
      return;
    }
    const t = Math.min(1, (Date.now() - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic — matches the CSS --ease used in the renderer
    const h = Math.round(startH + (target - startH) * eased);
    win.setSize(w, h, false);

    if (t >= 1) {
      if (animTimer) clearInterval(animTimer);
      animTimer = null;
    }
  }, 16);
}

function createWindow(anchor: BrowserWindow | null): void {
  const workArea = screen.getPrimaryDisplay().workArea;

  let x = workArea.x + workArea.width - DEFAULT_WIDTH - 24;
  let y = workArea.y + workArea.height - COLLAPSED_HEIGHT - 24;

  if (anchor && !anchor.isDestroyed()) {
    const bounds = anchor.getBounds();
    const preferredX = bounds.x + bounds.width + 16;
    x = preferredX + DEFAULT_WIDTH <= workArea.x + workArea.width ? preferredX : x;
    y = Math.min(bounds.y + bounds.height - COLLAPSED_HEIGHT - 12, workArea.y + workArea.height - COLLAPSED_HEIGHT - 12);
  }

  win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: COLLAPSED_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    minWidth: 300,
    minHeight: COLLAPSED_HEIGHT,
    icon: undefined,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(getConsoleHtmlPath());
  win.on("closed", () => {
    win = null;
  });
}

export function initConsoleWindow(): void {
  ipcMain.on(IpcChannel.ConsoleToggleCollapse, () => toggleCollapse());
  ipcMain.on(IpcChannel.ConsoleClose, () => {
    win?.hide();
  });
  // Fired by console.ts once its onLog listener is actually registered —
  // reply with everything logged so far so the backlog isn't silently gone.
  ipcMain.on(IpcChannel.ConsoleReady, (event) => {
    event.sender.send(IpcChannel.ConsoleHistory, history);
  });
}

function toggleCollapse(): void {
  if (!win || win.isDestroyed()) return;
  collapsed = !collapsed;

  if (collapsed) {
    const [, currentH] = win.getSize();
    if (currentH > COLLAPSED_HEIGHT + 4) expandedHeight = currentH;
    animateHeight(COLLAPSED_HEIGHT);
  } else {
    animateHeight(expandedHeight);
  }

  const state: ConsoleWindowState = { collapsed };
  win.webContents.send(IpcChannel.ConsoleState, state);
}

/** Shows the console window (creating it on first use) and expands it if collapsed. */
export function revealConsole(anchor: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) createWindow(anchor);
  if (!win) return;

  if (!win.isVisible()) win.show();

  if (collapsed) {
    collapsed = false;
    animateHeight(expandedHeight);
    win.webContents.send(IpcChannel.ConsoleState, { collapsed: false } as ConsoleWindowState);
  }
}

export function forwardLog(entry: LogEntry): void {
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.shift();

  if (win && !win.isDestroyed()) {
    win.webContents.send(IpcChannel.Log, entry);
  }
}

export function closeConsoleWindow(): void {
  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }
  if (win && !win.isDestroyed()) {
    win.close();
  }
  win = null;
}

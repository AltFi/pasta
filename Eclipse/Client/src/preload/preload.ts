import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import { IpcChannel, PulseBridge, WindowState, PipeStatus, LogEntry, ConsoleWindowState } from "../shared/ipc";

// contextIsolation is on and nodeIntegration is off, so this is the only
// surface the renderer gets — no raw ipcRenderer, no Node globals. Every
// method here is a thin, typed wrapper around a single well-known channel.

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: PulseBridge = {
  windowMinimize: () => ipcRenderer.send(IpcChannel.WindowMinimize),
  windowToggleMaximize: () => ipcRenderer.send(IpcChannel.WindowToggleMaximize),
  windowClose: () => ipcRenderer.send(IpcChannel.WindowClose),
  windowToggleFullscreen: () => ipcRenderer.send(IpcChannel.WindowToggleFullscreen),
  onWindowState: (cb: (state: WindowState) => void) => subscribe(IpcChannel.WindowState, cb),

  connect: () => ipcRenderer.invoke(IpcChannel.PipeConnect),
  disconnect: () => ipcRenderer.invoke(IpcChannel.PipeDisconnect),
  getStatus: () => ipcRenderer.invoke(IpcChannel.PipeStatus),
  onStatus: (cb: (status: PipeStatus) => void) => subscribe(IpcChannel.PipeStatus, cb),

  sendScript: (code: string) => ipcRenderer.invoke(IpcChannel.PipeSendScript, code),

  runInjector: (processName: string) => ipcRenderer.invoke(IpcChannel.InjectorRun, processName),
  isProcessRunning: (processName: string) => ipcRenderer.invoke(IpcChannel.ProcessCheck, processName),

  onLog: (cb: (entry: LogEntry) => void) => subscribe(IpcChannel.Log, cb),
  log: (level, message) => ipcRenderer.send(IpcChannel.LogFromRenderer, { level, message }),

  consoleToggleCollapse: () => ipcRenderer.send(IpcChannel.ConsoleToggleCollapse),
  consoleClose: () => ipcRenderer.send(IpcChannel.ConsoleClose),
  onConsoleState: (cb: (state: ConsoleWindowState) => void) => subscribe(IpcChannel.ConsoleState, cb),

  consoleReady: () => ipcRenderer.send(IpcChannel.ConsoleReady),
  onConsoleHistory: (cb: (entries: LogEntry[]) => void) => subscribe(IpcChannel.ConsoleHistory, cb),
};

contextBridge.exposeInMainWorld("pulse", bridge);

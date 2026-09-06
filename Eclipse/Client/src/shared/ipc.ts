// Shared, framework-agnostic IPC contract between the Electron main process
// and the renderer. Kept free of Node-only imports so it can be bundled by
// both tsc (main/preload) and Vite (renderer) without conflicts.

export const IpcChannel = {
  WindowMinimize: "window:minimize",
  WindowToggleMaximize: "window:toggle-maximize",
  WindowClose: "window:close",
  WindowToggleFullscreen: "window:toggle-fullscreen",
  WindowState: "window:state",

  PipeConnect: "pipe:connect",
  PipeDisconnect: "pipe:disconnect",
  PipeStatus: "pipe:status",
  PipeSendScript: "pipe:send-script",

  InjectorRun: "injector:run",
  ProcessCheck: "process:check",

  Log: "app:log",
  LogFromRenderer: "app:log-from-renderer",

  ConsoleToggleCollapse: "console:toggle-collapse",
  ConsoleClose: "console:close",
  ConsoleState: "console:state",
  ConsoleReady: "console:ready",
  ConsoleHistory: "console:history",
} as const;

export type ConsoleWindowState = {
  collapsed: boolean;
};

export type WindowState = {
  maximized: boolean;
  fullscreen: boolean;
};

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type PipeStatus = {
  state: ConnectionState;
  messagesSent: number;
  messagesReceived: number;
  lastError?: string;
};

export type PipeSendResult = {
  ok: boolean;
  responseText?: string;
  error?: string;
};

// The engine's TcpServer (Communication.cpp) understands exactly one wire
// message: "here is a script, queue it." There is no distinct command or
// heartbeat message type at the protocol level, so PulseBridge doesn't
// pretend to offer sendCommand/sendHeartbeat — those existed in the old
// client against a different, unrelated backend that no longer applies.

export type InjectorResult = {
  success: boolean;
  log: string;
  exitCode: number | null;
};

export type LogLevel = "info" | "success" | "warn" | "error";

export type LogEntry = {
  level: LogLevel;
  message: string;
  timestamp: number;
};

// Renderer-facing API surface exposed by the preload script via
// contextBridge. Declared here so both preload.ts (implementation) and
// renderer code (consumer, through the global `window.pulse`) share one
// source of truth for the shape of the bridge.
export interface PulseBridge {
  windowMinimize(): void;
  windowToggleMaximize(): void;
  windowClose(): void;
  windowToggleFullscreen(): void;
  onWindowState(cb: (state: WindowState) => void): () => void;

  connect(): Promise<PipeStatus>;
  disconnect(): Promise<PipeStatus>;
  getStatus(): Promise<PipeStatus>;
  onStatus(cb: (status: PipeStatus) => void): () => void;

  sendScript(code: string): Promise<PipeSendResult>;

  runInjector(processName: string): Promise<InjectorResult>;

  isProcessRunning(processName: string): Promise<boolean>;

  onLog(cb: (entry: LogEntry) => void): () => void;
  log(level: LogLevel, message: string): void;

  consoleToggleCollapse(): void;
  consoleClose(): void;
  onConsoleState(cb: (state: ConsoleWindowState) => void): () => void;

  // The console window is a separate BrowserWindow that loads its own
  // page asynchronously. Logs sent (main -> console renderer) before that
  // page has registered its onLog listener are simply lost — Electron
  // does not queue webContents.send() for a not-yet-ready renderer. The
  // console renderer calls consoleReady() once its listener is attached;
  // the main process replies with onConsoleHistory carrying everything
  // that was logged (and would otherwise have been dropped) up to that
  // point, so the console never opens to an empty backlog.
  consoleReady(): void;
  onConsoleHistory(cb: (entries: LogEntry[]) => void): () => void;
}

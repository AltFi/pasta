import { monaco, registerLuaCompletions } from "./monacoSetup";
import type { ConnectionState, PipeStatus, WindowState } from "../shared/ipc";

registerLuaCompletions();

// ---------------------------------------------------------------------
// Tab model
// ---------------------------------------------------------------------

interface Tab {
  id: string;
  name: string;
  model: monaco.editor.ITextModel;
  viewState: monaco.editor.ICodeEditorViewState | null;
  dirty: boolean;
  originId: string | null; // library entry this tab was opened from, if any
}

interface LibraryEntry {
  id: string;
  name: string;
  content: string;
  savedAt: number;
  autoExec: boolean;
}

const DEFAULT_SCRIPT = `-- PulseExecutor\nprint("Hello from PulseExecutor!")\n`;
const STORAGE_TABS = "pulse.tabs.v1";
const STORAGE_LIBRARY = "pulse.library.v2";
const STORAGE_SETTINGS = "pulse.settings.v3";

let tabs: Tab[] = [];
let activeTabId = "";
let tabCounter = 0;
let library: LibraryEntry[] = [];
let treeFilter = "";

interface Settings {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  accent: string;
  confirmDelete: boolean;
  defaultProcess: string;
}
let settings: Settings = {
  fontSize: 13,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  accent: "#3f8cff",
  confirmDelete: true,
  defaultProcess: "",
};

function localLog(level: "info" | "success" | "warn" | "error", message: string): void {
  window.pulse.log(level, message);
}

// ---------------------------------------------------------------------
// Toasts — lightweight, transient confirmation for actions the console
// log already records but that deserve an in-the-moment acknowledgement
// (deletions, settings reset, drag-and-drop import) without requiring the
// console window to be open.
// ---------------------------------------------------------------------

const TOAST_ICONS: Record<string, string> = {
  info: '<circle cx="7" cy="7" r="5.3"/><path d="M7 6.3v3.4M7 4.3h.01"/>',
  success: '<path d="M3.5 7.3l2.3 2.3 4.7-5.2"/>',
  warn: '<path d="M7 1.5 13 12H1z"/><path d="M7 5.5v3M7 10h.01"/>',
  error: '<circle cx="7" cy="7" r="5.3"/><path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4"/>',
};

function showToast(level: "info" | "success" | "warn" | "error", message: string, durationMs = 3200): void {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;

  const el = document.createElement("div");
  el.className = `toast ${level}`;
  el.innerHTML = `<svg class="toast-icon" viewBox="0 0 14 14" stroke-width="1.8" fill="none">${
    TOAST_ICONS[level] ?? TOAST_ICONS.info
  }</svg><span class="toast-message"></span>`;
  el.querySelector(".toast-message")!.textContent = message;

  const dismiss = () => {
    el.classList.add("leaving");
    el.classList.remove("show");
    window.setTimeout(() => el.remove(), 180);
  };
  el.addEventListener("click", dismiss);

  stack.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
  window.setTimeout(dismiss, durationMs);
}

// ---------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------

const editorHost = document.getElementById("editor")!;
const editor = monaco.editor.create(editorHost, {
  theme: "pulse-dark",
  language: "lua",
  automaticLayout: true,
  fontFamily: '"Cascadia Code", "SF Mono", Consolas, monospace',
  fontSize: settings.fontSize,
  fontLigatures: true,
  lineHeight: 21,
  minimap: { enabled: false },
  smoothScrolling: true,
  cursorBlinking: "smooth",
  cursorSmoothCaretAnimation: "on",
  padding: { top: 12, bottom: 12 },
  scrollBeyondLastLine: false,
  renderLineHighlight: "all",
  wordWrap: settings.wordWrap ? "on" : "off",
  tabSize: 4,
  insertSpaces: true,
  fixedOverflowWidgets: true,
  quickSuggestions: true,
  suggestOnTriggerCharacters: true,
  tabCompletion: "on",
  parameterHints: { enabled: true },
});

function newTabId(): string {
  tabCounter += 1;
  return `tab-${Date.now()}-${tabCounter}`;
}

function createTab(name: string, content: string, activate = true, originId: string | null = null): Tab {
  const model = monaco.editor.createModel(content, "lua");
  const tab: Tab = { id: newTabId(), name, model, viewState: null, dirty: false, originId };

  model.onDidChangeContent(() => {
    tab.dirty = true;
    updateTabElement(tab);
    scheduleSave();
  });

  tabs.push(tab);
  if (activate) switchTab(tab.id);
  else renderTabs();
  return tab;
}

function switchTab(id: string): void {
  const current = tabs.find((t) => t.id === activeTabId);
  if (current) current.viewState = editor.saveViewState();

  const next = tabs.find((t) => t.id === id);
  if (!next) return;

  activeTabId = id;
  editor.setModel(next.model);
  if (next.viewState) editor.restoreViewState(next.viewState);
  editor.focus();

  renderTabs();
  renderLibrary();
  updateBreadcrumb();
  updateStatusPosition();
}

function closeTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const [removed] = tabs.splice(idx, 1);
  const content = removed.model.getValue();
  removed.model.dispose();
  removeTabElement(id);

  if (content.trim().length > 0) {
    if (removed.originId) {
      // Tab was opened from an existing Workspace entry — sync edits back
      // into that entry instead of archiving a duplicate.
      syncEntryContent(removed.originId, content);
    } else {
      archiveToLibrary(removed.name, content);
    }
  }

  if (tabs.length === 0) {
    createTab(`Script ${tabCounter + 1}`, DEFAULT_SCRIPT);
    return;
  }

  if (activeTabId === id) {
    const neighbor = tabs[Math.max(0, idx - 1)];
    switchTab(neighbor.id);
  } else {
    renderTabs();
  }
  scheduleSave();
}

function renameTab(id: string, name: string): void {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  tab.name = name.trim() || tab.name;
  updateTabElement(tab);
  updateBreadcrumb();

  // A tab opened from a Workspace entry (originId set) used to only ever
  // rename the tab itself — the sidebar's library entry silently kept its
  // old name forever, since syncEntryContent/syncOpenOriginTabs only ever
  // synced *content*, never the name. Renaming a saved script had no way
  // to actually reach the sidebar.
  if (tab.originId) {
    const entry = library.find((l) => l.id === tab.originId);
    if (entry) {
      entry.name = tab.name;
      persistLibrary();
      renderLibrary();
    }
  }

  scheduleSave();
}

// ---------------------------------------------------------------------
// Tab UI — persistent DOM elements (never fully rebuilt) so CSS
// transitions on hover/active/enter/leave actually have something
// continuous to animate between, plus a sliding active-tab indicator.
// ---------------------------------------------------------------------

const tabsEl = document.getElementById("tabs")!;
const tabIndicator = document.createElement("div");
tabIndicator.className = "tab-indicator";
tabsEl.appendChild(tabIndicator);

const tabElements = new Map<string, HTMLElement>();

function buildTabElement(tab: Tab): HTMLElement {
  const el = document.createElement("div");
  el.className = "tab entering";
  el.dataset.id = tab.id;

  const dot = document.createElement("span");
  dot.className = "tab-dirty";

  const name = document.createElement("span");
  name.className = "tab-name";
  name.textContent = tab.name;

  const close = document.createElement("button");
  close.className = "tab-close";
  close.innerHTML = '<svg viewBox="0 0 8 8"><path d="M1 1l6 6M7 1L1 7"/></svg>';
  close.title = "Close tab";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });

  el.appendChild(dot);
  el.appendChild(name);
  el.appendChild(close);

  el.addEventListener("click", () => switchTab(tab.id));
  el.addEventListener("dblclick", () => startRename(tab.id, el, name));

  tabsEl.insertBefore(el, tabIndicator);

  // Double rAF: let the browser paint the "entering" (offset/scaled) state
  // first, then remove the class so the transition to rest actually plays.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("entering")));

  return el;
}

function updateTabElement(tab: Tab): void {
  const el = tabElements.get(tab.id);
  if (!el) return;
  el.classList.toggle("active", tab.id === activeTabId);
  const nameEl = el.querySelector<HTMLElement>(".tab-name");
  if (nameEl && nameEl.textContent !== tab.name) nameEl.textContent = tab.name;
}

function removeTabElement(id: string): void {
  const el = tabElements.get(id);
  if (!el) return;
  tabElements.delete(id);
  el.classList.add("leaving");
  window.setTimeout(() => el.remove(), 190);
}

function updateTabIndicator(): void {
  const activeEl = tabElements.get(activeTabId);
  if (!activeEl) {
    tabIndicator.style.opacity = "0";
    return;
  }
  tabIndicator.style.opacity = "1";
  tabIndicator.style.transform = `translateX(${activeEl.offsetLeft}px)`;
  tabIndicator.style.width = `${activeEl.offsetWidth}px`;
}

function renderTabs(): void {
  for (const tab of tabs) {
    if (!tabElements.has(tab.id)) {
      tabElements.set(tab.id, buildTabElement(tab));
    }
    updateTabElement(tab);
  }
  // Indicator position depends on layout, so measure after the browser has
  // had a chance to place any newly-inserted tab.
  requestAnimationFrame(updateTabIndicator);
}

function startRename(id: string, tabEl: HTMLElement, nameEl: HTMLElement): void {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;

  const input = document.createElement("input");
  input.value = tab.name;
  input.style.cssText =
    "background:transparent;border:none;outline:none;color:inherit;font:inherit;width:80px;padding:0;";
  input.spellcheck = false;

  tabEl.replaceChild(input, nameEl);
  input.focus();
  input.select();

  const commit = () => {
    renameTab(id, input.value);
    // Swap the temporary <input> back for a proper .tab-name span so
    // updateTabElement can find it again on future re-renders.
    const span = document.createElement("span");
    span.className = "tab-name";
    span.textContent = tab.name;
    if (input.parentElement) input.replaceWith(span);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.value = tab.name;
      input.blur();
    }
  });
}

document.getElementById("tab-add")!.addEventListener("click", () => {
  createTab(`Script ${tabCounter + 1}`, "");
});

window.addEventListener("resize", () => updateTabIndicator());

// ---------------------------------------------------------------------
// Breadcrumb + status bar
// ---------------------------------------------------------------------

const breadcrumbFile = document.getElementById("breadcrumb-file")!;
const sbFilename = document.getElementById("sb-filename")!;
const sbPosition = document.getElementById("sb-position")!;
const sbIndent = document.getElementById("sb-indent")!;

function updateBreadcrumb(): void {
  const tab = tabs.find((t) => t.id === activeTabId);
  const name = tab?.name ?? "";
  breadcrumbFile.textContent = name;
  sbFilename.textContent = name;
}

function updateStatusPosition(): void {
  const pos = editor.getPosition();
  if (!pos) return;
  sbPosition.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
}
sbIndent.textContent = "Spaces: 4";

editor.onDidChangeCursorPosition(updateStatusPosition);

// ---------------------------------------------------------------------
// Persistence (localStorage) — best-effort, purely local convenience
// ---------------------------------------------------------------------

let saveTimer: number | undefined;
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistTabs, 400);
}

function persistTabs(): void {
  try {
    const data = tabs.map((t) => ({ name: t.name, content: t.model.getValue() }));
    localStorage.setItem(STORAGE_TABS, JSON.stringify({ tabs: data, active: tabs.findIndex((t) => t.id === activeTabId) }));
  } catch {
    /* storage unavailable — non-fatal */
  }
  syncOpenOriginTabs();
}

function restoreTabs(): void {
  try {
    const raw = localStorage.getItem(STORAGE_TABS);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw) as { tabs: Array<{ name: string; content: string }>; active: number };
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) throw new Error("empty");

    for (const t of parsed.tabs) createTab(t.name, t.content, false);
    const activeIdx = Math.min(Math.max(parsed.active, 0), tabs.length - 1);
    switchTab(tabs[activeIdx].id);
  } catch {
    createTab("Script 1", DEFAULT_SCRIPT);
  }
}

// ---------------------------------------------------------------------
// Sidebar tree: Workspace (library) + Auto Execute
// ---------------------------------------------------------------------

const workspaceBody = document.getElementById("tree-workspace-body")!;
const workspaceEmpty = document.getElementById("tree-workspace-empty")!;
const autoexecBody = document.getElementById("tree-autoexec-body")!;
const autoexecEmpty = document.getElementById("tree-autoexec-empty")!;

function loadLibrary(): void {
  try {
    const raw = localStorage.getItem(STORAGE_LIBRARY);
    library = raw ? (JSON.parse(raw) as LibraryEntry[]) : [];
    if (!Array.isArray(library)) library = [];
  } catch {
    library = [];
  }
}

function persistLibrary(): void {
  try {
    localStorage.setItem(STORAGE_LIBRARY, JSON.stringify(library));
  } catch {
    /* non-fatal */
  }
}

function archiveToLibrary(name: string, content: string): void {
  library.unshift({
    id: `lib-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    content,
    savedAt: Date.now(),
    autoExec: false,
  });
  if (library.length > 80) library = library.slice(0, 80);
  persistLibrary();
  renderLibrary();
}

/** Writes a tab's current content back into the Workspace entry it came from. */
function syncEntryContent(entryId: string, content: string): void {
  const entry = library.find((l) => l.id === entryId);
  if (!entry) return;
  entry.content = content;
  entry.savedAt = Date.now();
  persistLibrary();
}

/** Inline rename for a Workspace sidebar entry — mirrors startRename's tab
 * version, but also pushes the new name onto any currently-open tab that
 * originated from this entry, so the tab and sidebar never show two
 * different names for the same script. */
function startTreeItemRename(entry: LibraryEntry, itemEl: HTMLElement, nameEl: HTMLElement): void {
  const input = document.createElement("input");
  input.value = entry.name;
  input.className = "tree-item-name";
  input.style.cssText = "background:transparent;border:none;outline:none;color:inherit;font:inherit;width:100%;padding:0;";
  input.spellcheck = false;

  itemEl.replaceChild(input, nameEl);
  input.focus();
  input.select();

  const commit = () => {
    const newName = input.value.trim();
    if (newName && newName !== entry.name) {
      entry.name = newName;
      persistLibrary();

      const openTab = tabs.find((t) => t.originId === entry.id);
      if (openTab) {
        openTab.name = entry.name;
        updateTabElement(openTab);
        updateBreadcrumb();
        scheduleSave();
      }
    }
    renderLibrary();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.value = entry.name;
      input.blur();
    }
  });
}

/** Keeps every open tab that originated from a Workspace entry in sync with
 * that entry as the user types, so edits aren't only saved on tab close. */
function syncOpenOriginTabs(): void {
  let changed = false;
  for (const tab of tabs) {
    if (!tab.originId) continue;
    const entry = library.find((l) => l.id === tab.originId);
    if (!entry) continue;
    const content = tab.model.getValue();
    if (entry.content !== content) {
      entry.content = content;
      entry.savedAt = Date.now();
      changed = true;
    }
  }
  if (changed) persistLibrary();
}

function fileIconSvg(): string {
  return '<svg class="tree-item-icon" viewBox="0 0 14 14"><path d="M3 2h5l3 3v7H3z"/><path d="M8 2v3h3"/></svg>';
}

const selectedLibraryIds = new Set<string>();

function updateSelectionBar(): void {
  const bar = document.getElementById("tree-selection-bar")!;
  const count = document.getElementById("tree-selection-count")!;
  bar.dataset.open = String(selectedLibraryIds.size > 0);
  count.textContent = `${selectedLibraryIds.size} selected`;
}

function buildTreeItem(entry: LibraryEntry): HTMLElement {
  const el = document.createElement("div");
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isActive = !!activeTab && activeTab.originId === entry.id;
  const isSelected = selectedLibraryIds.has(entry.id);
  el.className = "tree-item" + (isActive ? " active" : "") + (isSelected ? " selected" : "");

  const icon = document.createElement("span");
  icon.innerHTML = fileIconSvg();

  const name = document.createElement("span");
  name.className = "tree-item-name";
  name.textContent = entry.name;
  name.title = "Double-click to rename";
  name.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startTreeItemRename(entry, el, name);
  });

  const actions = document.createElement("div");
  actions.className = "tree-item-actions";

  const pin = document.createElement("button");
  pin.className = "tree-item-action" + (entry.autoExec ? " pinned" : "");
  pin.title = entry.autoExec ? "Remove from Auto Execute" : "Add to Auto Execute";
  pin.innerHTML = '<svg viewBox="0 0 10 10"><path d="M5 1.5v3.2M2.2 8.5 5 5.7l2.8 2.8M3 4.7h4l-.6 2H3.6z"/></svg>';
  pin.addEventListener("click", (e) => {
    e.stopPropagation();
    entry.autoExec = !entry.autoExec;
    persistLibrary();
    renderLibrary();
  });
  actions.appendChild(pin);

  const del = document.createElement("button");
  del.className = "tree-item-action";
  del.title = "Delete";
  del.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2 3h8M4.5 3V1.8h3V3M3 3l.6 7.2h4.8L9 3"/></svg>';
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    if (settings.confirmDelete && !confirm(`Delete "${entry.name}"? This can't be undone.`)) return;
    library = library.filter((l) => l.id !== entry.id);
    persistLibrary();
    renderLibrary();
    showToast("info", `Deleted "${entry.name}"`);
  });
  actions.appendChild(del);

  el.appendChild(icon);
  el.appendChild(name);
  el.appendChild(actions);

  el.addEventListener("click", (e) => {
    // Ctrl/Cmd-click toggles multi-select for batch execute instead of
    // opening the script — the sidebar hint ("Ctrl-click to select") is
    // the only discoverability this gets, so keep the plain-click path
    // (open as tab) as the obvious default.
    if (e.ctrlKey || e.metaKey) {
      if (selectedLibraryIds.has(entry.id)) selectedLibraryIds.delete(entry.id);
      else selectedLibraryIds.add(entry.id);
      renderLibrary();
      return;
    }

    const existing = tabs.find((t) => t.originId === entry.id);
    if (existing) {
      switchTab(existing.id);
    } else {
      createTab(entry.name, entry.content, true, entry.id);
    }
  });

  return el;
}

function renderLibrary(): void {
  const filtered = library.filter((l) => l.name.toLowerCase().includes(treeFilter));
  const filteredIds = new Set(filtered.map((l) => l.id));
  for (const id of [...selectedLibraryIds]) {
    if (!filteredIds.has(id)) selectedLibraryIds.delete(id);
  }

  workspaceBody.querySelectorAll(".tree-item").forEach((el) => el.remove());
  workspaceEmpty.style.display = filtered.length === 0 ? "block" : "none";
  for (const entry of filtered) {
    workspaceBody.appendChild(buildTreeItem(entry));
  }

  const pinned = filtered.filter((l) => l.autoExec);
  autoexecBody.querySelectorAll(".tree-item").forEach((el) => el.remove());
  autoexecEmpty.style.display = pinned.length === 0 ? "block" : "none";
  for (const entry of pinned) {
    autoexecBody.appendChild(buildTreeItem(entry));
  }

  updateSelectionBar();
}

document.getElementById("tree-add-workspace")!.addEventListener("click", () => {
  const tab = createTab(`Script ${tabCounter + 1}`, "");
  archiveToLibrary(tab.name, "");
  const entry = library[0];
  tab.originId = entry.id;
});

document.getElementById("tree-selection-clear")!.addEventListener("click", () => {
  selectedLibraryIds.clear();
  renderLibrary();
});

document.getElementById("tree-selection-run")!.addEventListener("click", async () => {
  const runBtn = document.getElementById("tree-selection-run") as HTMLButtonElement;
  const selected = library.filter((l) => selectedLibraryIds.has(l.id));
  if (selected.length === 0) return;

  runBtn.disabled = true;
  try {
    let okCount = 0;
    for (const entry of selected) {
      if (await runScriptCode(entry.content, entry.name)) okCount++;
    }
    showToast(
      okCount === selected.length ? "success" : okCount > 0 ? "warn" : "error",
      `${okCount}/${selected.length} selected script${selected.length > 1 ? "s" : ""} queued`
    );
  } finally {
    runBtn.disabled = false;
  }
});

document.getElementById("tree-search")!.addEventListener("input", (e) => {
  treeFilter = (e.target as HTMLInputElement).value.trim().toLowerCase();
  renderLibrary();
});

document.querySelectorAll<SVGElement>(".tree-chevron").forEach((chevron) => {
  chevron.addEventListener("click", () => {
    const section = chevron.dataset.section;
    const body = document.getElementById(`tree-${section}-body`);
    if (!body) return;
    const open = body.dataset.open !== "false";
    body.dataset.open = String(!open);
    chevron.classList.toggle("collapsed", open);
  });
});

// ---------------------------------------------------------------------
// Auto Execute — runs pinned scripts once after a successful injection
// ---------------------------------------------------------------------

async function runAutoExecuteScripts(): Promise<void> {
  const pinned = library.filter((l) => l.autoExec);
  if (pinned.length === 0) return;

  localLog("info", `Running ${pinned.length} auto-execute script${pinned.length > 1 ? "s" : ""}…`);
  let okCount = 0;
  for (const entry of pinned) {
    if (await runScriptCode(entry.content, entry.name)) okCount++;
  }
  showToast(
    okCount === pinned.length ? "success" : okCount > 0 ? "warn" : "error",
    `Auto Execute: ${okCount}/${pinned.length} script${pinned.length > 1 ? "s" : ""} queued`
  );
}

// ---------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------

const settingsOverlay = document.getElementById("settings-overlay")!;
const fontValueEl = document.getElementById("font-value")!;
const wrapToggle = document.getElementById("wrap-toggle") as HTMLInputElement;
const minimapToggle = document.getElementById("minimap-toggle") as HTMLInputElement;
const lineNumbersToggle = document.getElementById("linenumbers-toggle") as HTMLInputElement;
const confirmDeleteToggle = document.getElementById("confirm-delete-toggle") as HTMLInputElement;
const defaultProcessInput = document.getElementById("default-process-input") as HTMLInputElement;
const accentGrid = document.getElementById("accent-grid")!;
const accentHexInput = document.getElementById("accent-hex") as HTMLInputElement;
const accentPickerInput = document.getElementById("accent-picker") as HTMLInputElement;

const ACCENT_PRESETS = ["#3f8cff", "#8b5cf6", "#22c55e", "#ef4444", "#f59e0b", "#ec4899", "#06b6d4", "#f2f4f8"];
const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  accent: "#3f8cff",
  confirmDelete: true,
  defaultProcess: "",
};

function loadSettings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    if (raw) settings = { ...settings, ...JSON.parse(raw) };
  } catch {
    /* use defaults */
  }
}

function persistSettings(): void {
  try {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
  } catch {
    /* non-fatal */
  }
}

function isValidHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

// Derives the two accent variants the token system needs (--accent-strong,
// --accent-dim) from a single base hex, so picking one color is enough —
// matches how the two blue/amber palettes tried by hand earlier this
// session both paired a base with a lighter "strong" and a translucent "dim".
function applyAccent(hex: string): void {
  if (!isValidHex(hex)) return;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lighten = (c: number) => Math.round(c + (255 - c) * 0.28);

  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  root.setProperty("--accent-strong", `rgb(${lighten(r)}, ${lighten(g)}, ${lighten(b)})`);
  root.setProperty("--accent-dim", `rgba(${r}, ${g}, ${b}, 0.18)`);

  accentHexInput.value = hex;
  accentPickerInput.value = hex;
  accentGrid.querySelectorAll<HTMLElement>(".accent-swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.hex?.toLowerCase() === hex.toLowerCase());
  });
}

function buildAccentGrid(): void {
  accentGrid.innerHTML = "";
  for (const hex of ACCENT_PRESETS) {
    const swatch = document.createElement("button");
    swatch.className = "accent-swatch";
    swatch.style.background = hex;
    swatch.dataset.hex = hex;
    swatch.title = hex;
    swatch.addEventListener("click", () => {
      settings.accent = hex;
      applyAccent(hex);
      persistSettings();
    });
    accentGrid.appendChild(swatch);
  }
}

function applyEditorSettings(): void {
  editor.updateOptions({
    fontSize: settings.fontSize,
    wordWrap: settings.wordWrap ? "on" : "off",
    minimap: { enabled: settings.minimap },
    lineNumbers: settings.lineNumbers ? "on" : "off",
  });
  fontValueEl.textContent = String(settings.fontSize);
  wrapToggle.checked = settings.wordWrap;
  minimapToggle.checked = settings.minimap;
  lineNumbersToggle.checked = settings.lineNumbers;
  confirmDeleteToggle.checked = settings.confirmDelete;
  defaultProcessInput.value = settings.defaultProcess;
  applyAccent(settings.accent);
}

document.getElementById("btn-settings")!.addEventListener("click", () => {
  settingsOverlay.dataset.open = "true";
});
document.getElementById("btn-settings-close")!.addEventListener("click", () => {
  settingsOverlay.dataset.open = "false";
});
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.dataset.open = "false";
});

document.getElementById("font-dec")!.addEventListener("click", () => {
  settings.fontSize = Math.max(10, settings.fontSize - 1);
  applyEditorSettings();
  persistSettings();
});
document.getElementById("font-inc")!.addEventListener("click", () => {
  settings.fontSize = Math.min(22, settings.fontSize + 1);
  applyEditorSettings();
  persistSettings();
});
wrapToggle.addEventListener("change", () => {
  settings.wordWrap = wrapToggle.checked;
  applyEditorSettings();
  persistSettings();
});
minimapToggle.addEventListener("change", () => {
  settings.minimap = minimapToggle.checked;
  applyEditorSettings();
  persistSettings();
});
lineNumbersToggle.addEventListener("change", () => {
  settings.lineNumbers = lineNumbersToggle.checked;
  applyEditorSettings();
  persistSettings();
});
confirmDeleteToggle.addEventListener("change", () => {
  settings.confirmDelete = confirmDeleteToggle.checked;
  persistSettings();
});
defaultProcessInput.addEventListener("change", () => {
  settings.defaultProcess = defaultProcessInput.value.trim();
  persistSettings();
});

accentHexInput.addEventListener("change", () => {
  const value = accentHexInput.value.trim();
  const normalized = value.startsWith("#") ? value : `#${value}`;
  if (!isValidHex(normalized)) {
    accentHexInput.value = settings.accent;
    return;
  }
  settings.accent = normalized;
  applyAccent(normalized);
  persistSettings();
});
accentPickerInput.addEventListener("input", () => {
  settings.accent = accentPickerInput.value;
  applyAccent(accentPickerInput.value);
  persistSettings();
});

document.getElementById("btn-settings-reset")!.addEventListener("click", () => {
  settings = { ...DEFAULT_SETTINGS };
  applyEditorSettings();
  persistSettings();
  showToast("info", "Settings reset to defaults");
});

// Settings rail — category switching.
document.getElementById("settings-rail")!.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".settings-rail-item");
  if (!btn) return;
  const pane = btn.dataset.pane;

  document.querySelectorAll("#settings-rail .settings-rail-item").forEach((el) => el.classList.toggle("active", el === btn));
  document.querySelectorAll(".settings-pane").forEach((el) => el.classList.toggle("active", (el as HTMLElement).dataset.pane === pane));
});

buildAccentGrid();

// ---------------------------------------------------------------------
// Connection status — drives the link button + inline status text
// ---------------------------------------------------------------------

const linkBtn = document.getElementById("btn-inject") as HTMLButtonElement;
const injectStatus = document.getElementById("inject-status")!;

const STATE_LABEL: Record<ConnectionState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Connection error",
};

function applyStatus(status: PipeStatus): void {
  linkBtn.className = "link-btn" + (status.state !== "disconnected" ? ` ${status.state}` : "");
  linkBtn.title = status.state === "connected" ? "Disconnect" : "Inject";
  injectStatus.className = "inject-status" + (status.state !== "disconnected" ? ` ${status.state}` : "");
  injectStatus.textContent = STATE_LABEL[status.state];
}

window.pulse.onStatus(applyStatus);
window.pulse.getStatus().then(applyStatus);

// ---------------------------------------------------------------------
// Live process detection (polled)
// ---------------------------------------------------------------------

const DEFAULT_PROCESS_NAME = "RobloxPlayerBeta.exe";

const processInput = document.getElementById("process-input") as HTMLInputElement;
const processLiveDot = document.getElementById("process-live-dot")!;

function targetProcessName(): string {
  return processInput.value.trim() || settings.defaultProcess || DEFAULT_PROCESS_NAME;
}

async function pollProcessLive(): Promise<void> {
  const name = targetProcessName();
  try {
    const running = await window.pulse.isProcessRunning(name);
    processLiveDot.classList.toggle("live", running);
    processLiveDot.title = running ? `${name} is running` : `${name} not detected`;
  } catch {
    /* ignore transient errors */
  }
}
window.setInterval(pollProcessLive, 4000);
processInput.addEventListener("change", pollProcessLive);

// ---------------------------------------------------------------------
// Actions: Run / Inject (link) / Stop / Clear
// ---------------------------------------------------------------------

const btnRun = document.getElementById("btn-run") as HTMLButtonElement;
const btnClear = document.getElementById("btn-clear") as HTMLButtonElement;

// Shared by the Run button and batch "Run selected" in the Workspace
// sidebar — one place that actually sends a script and reports the
// outcome, so both paths stay honest about what "success" means.
async function runScriptCode(code: string, label: string): Promise<boolean> {
  if (!code.trim()) {
    localLog("warn", `${label}: script is empty — nothing to run`);
    return false;
  }

  const status = await window.pulse.getStatus();
  if (status.state !== "connected") {
    localLog("error", `Engine not reachable. Status: ${status.state}. Click 'Link/Inject' first.`);
    if (status.lastError) localLog("error", `Connection error: ${status.lastError}`);
    return false;
  }

  try {
    localLog("info", `${label}: sending…`);
    const result = await window.pulse.sendScript(code);
    if (!result.ok) {
      localLog("error", `${label}: send failed — ${result.error ?? "Unknown error"}`);
      return false;
    }
    // The engine only acknowledges that the script was accepted and
    // queued for execution on Roblox's own render thread — it can't yet
    // report back whether the script actually ran without error. Worded
    // to match what's actually confirmed, not implied further than that.
    localLog("success", `✓ ${label}: queued — ${result.responseText ?? "accepted by engine"}`);
    return true;
  } catch (err) {
    localLog("error", `${label}: error sending script — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

btnRun.addEventListener("click", async () => {
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (!activeTab) return;

  btnRun.disabled = true;
  try {
    const ok = await runScriptCode(activeTab.model.getValue(), activeTab.name);
    showToast(ok ? "success" : "error", ok ? "Script queued" : "Failed to send script");
  } finally {
    btnRun.disabled = false;
  }
});

btnClear.addEventListener("click", () => {
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (!activeTab || activeTab.model.getValue().length === 0) return;
  activeTab.model.setValue("");
  editor.focus();
});

// The link button doubles as connect/disconnect: click it while disconnected
// to inject + auto-connect + fire pinned Auto Execute scripts; click again
// while connected to disconnect. One control instead of two.
linkBtn.addEventListener("click", async () => {
  linkBtn.disabled = true;
  try {
    const status = await window.pulse.getStatus();
    if (status.state === "connected") {
      applyStatus(await window.pulse.disconnect());
      showToast("info", "Disconnected");
      return;
    }

    const result = await window.pulse.runInjector(targetProcessName());
    if (!result.success) {
      showToast("error", "Injection failed — check the console for details");
      return;
    }

    const connectResult = await window.pulse.connect().catch(() => null);
    if (connectResult) applyStatus(connectResult);
    if (connectResult?.state === "connected") {
      showToast("success", "Injected and engine reachable");
      await runAutoExecuteScripts();
    } else {
      showToast("warn", "Injected, but the engine didn't respond — see console");
    }
  } finally {
    linkBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Drag-and-drop script import — drop a .lua/.txt file anywhere on the
// window to open it as a new tab. Electron navigates to/opens dropped
// files by default if this isn't prevented at the window level, so the
// dragover/drop listeners below are global (window), not scoped to the
// editor, even though the editor is the only thing that visually reacts.
// ---------------------------------------------------------------------

const editorWrap = document.querySelector<HTMLElement>(".editor-wrap")!;
let dragDepth = 0;

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  editorWrap.classList.add("drag-over");
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) editorWrap.classList.remove("drag-over");
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  editorWrap.classList.remove("drag-over");

  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => /\.(lua|txt)$/i.test(f.name));
  if (files.length === 0) return;

  for (const file of files) {
    const content = await file.text();
    const name = file.name.replace(/\.(lua|txt)$/i, "");
    createTab(name, content);
  }
  showToast("success", `Imported ${files.length} file${files.length > 1 ? "s" : ""}`);
});

const shellEl = document.querySelector<HTMLElement>(".shell")!;
const iconMaximize = document.getElementById("icon-maximize")!;

document.getElementById("btn-close")!.addEventListener("click", () => window.pulse.windowClose());
document.getElementById("btn-minimize")!.addEventListener("click", () => window.pulse.windowMinimize());
document.getElementById("btn-maximize")!.addEventListener("click", () => window.pulse.windowToggleMaximize());

window.pulse.onWindowState((state: WindowState) => {
  shellEl.classList.toggle("maximized", state.maximized);
  iconMaximize.innerHTML = state.maximized
    ? '<rect x="2.25" y="1" width="5" height="5" rx="0.5"/><rect x="1" y="2.25" width="5" height="5" rx="0.5" fill="var(--bg-panel)"/>'
    : '<rect x="1.75" y="1.75" width="6.5" height="6.5" rx="0.5"/>';
});

// ---------------------------------------------------------------------
// Command palette (Ctrl+K) — quick actions + fuzzy-ish jump to any
// Workspace script, in one place instead of hunting through menus/sidebar.
// ---------------------------------------------------------------------

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

const paletteOverlay = document.getElementById("palette-overlay")!;
const paletteInput = document.getElementById("palette-input") as HTMLInputElement;
const paletteList = document.getElementById("palette-list")!;
const paletteTrigger = document.getElementById("palette-trigger")!;

const ICON_RUN = '<path d="M4.5 2.8v10.4l9-5.2-9-5.2z" fill="currentColor" stroke="none"/>';
const ICON_TAB = '<path d="M6 1v10M1 6h10"/>';
const ICON_LINK = '<path d="M6.3 9.7 9.7 6.3M4.3 11.7a3.2 3.2 0 0 1 0-4.5l1.9-1.9a3.2 3.2 0 0 1 4.5 0M11.7 4.3a3.2 3.2 0 0 1 0 4.5l-1.9 1.9a3.2 3.2 0 0 1-4.5 0"/>';
const ICON_CONSOLE = '<path d="M2 3.5h10M2.5 3.5v7a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-7"/><path d="M4.5 7l2 1.5-2 1.5"/>';
const ICON_SETTINGS = '<path d="M2 4h7M12 4h2"/><circle cx="10" cy="4" r="1.3" fill="currentColor" stroke="none"/><path d="M2 8h2M7 8h7"/><circle cx="5" cy="8" r="1.3" fill="currentColor" stroke="none"/><path d="M2 12h7M12 12h2"/><circle cx="10" cy="12" r="1.3" fill="currentColor" stroke="none"/>';
const ICON_FILE = '<path d="M3 2h5l3 3v7H3z"/><path d="M8 2v3h3"/>';

let paletteActive = -1;
let paletteMatches: PaletteAction[] = [];

function staticPaletteActions(): PaletteAction[] {
  const injectLabel = linkBtn.classList.contains("connected") ? "Disconnect" : "Inject";
  return [
    { id: "run", label: "Run script", hint: "Ctrl Enter", icon: ICON_RUN, run: () => btnRun.click() },
    { id: "tab", label: "New tab", hint: "Ctrl T", icon: ICON_TAB, run: () => createTab(`Script ${tabCounter + 1}`, "") },
    { id: "inject", label: injectLabel, icon: ICON_LINK, run: () => linkBtn.click() },
    { id: "console", label: "Toggle console", icon: ICON_CONSOLE, run: () => window.pulse.consoleToggleCollapse() },
    { id: "settings", label: "Open settings", icon: ICON_SETTINGS, run: () => { settingsOverlay.dataset.open = "true"; } },
  ];
}

function scriptPaletteActions(): PaletteAction[] {
  return library.map((entry) => ({
    id: `lib-${entry.id}`,
    label: entry.name,
    hint: entry.autoExec ? "Auto Execute" : undefined,
    icon: ICON_FILE,
    run: () => {
      const existing = tabs.find((t) => t.originId === entry.id);
      if (existing) switchTab(existing.id);
      else createTab(entry.name, entry.content, true, entry.id);
    },
  }));
}

function renderPalette(): void {
  const query = paletteInput.value.trim().toLowerCase();
  const all = [...staticPaletteActions(), ...scriptPaletteActions()];
  paletteMatches = query ? all.filter((a) => a.label.toLowerCase().includes(query)) : all;
  paletteActive = paletteMatches.length > 0 ? 0 : -1;

  paletteList.innerHTML = "";
  if (paletteMatches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = "No matches";
    paletteList.appendChild(empty);
    return;
  }

  paletteMatches.forEach((action, i) => {
    const el = document.createElement("div");
    el.className = "palette-item" + (i === paletteActive ? " active" : "");
    el.innerHTML = `<svg viewBox="0 0 14 14" stroke-width="1.5" fill="none">${action.icon}</svg><span class="palette-item-label"></span>${
      action.hint ? `<span class="palette-item-hint"></span>` : ""
    }`;
    el.querySelector(".palette-item-label")!.textContent = action.label;
    if (action.hint) el.querySelector(".palette-item-hint")!.textContent = action.hint;
    el.addEventListener("mouseenter", () => setPaletteActive(i));
    el.addEventListener("click", () => runPaletteAction(action));
    paletteList.appendChild(el);
  });
}

function setPaletteActive(index: number): void {
  paletteActive = index;
  paletteList.querySelectorAll(".palette-item").forEach((el, i) => el.classList.toggle("active", i === index));
}

function runPaletteAction(action: PaletteAction): void {
  closePalette();
  action.run();
}

function openPalette(): void {
  paletteInput.value = "";
  paletteOverlay.dataset.open = "true";
  renderPalette();
  requestAnimationFrame(() => paletteInput.focus());
}

function closePalette(): void {
  paletteOverlay.dataset.open = "false";
}

function isPaletteOpen(): boolean {
  return paletteOverlay.dataset.open === "true";
}

paletteTrigger.addEventListener("click", openPalette);
paletteInput.addEventListener("input", renderPalette);
paletteOverlay.addEventListener("click", (e) => {
  if (e.target === paletteOverlay) closePalette();
});

paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (paletteMatches.length > 0) setPaletteActive((paletteActive + 1) % paletteMatches.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (paletteMatches.length > 0) setPaletteActive((paletteActive - 1 + paletteMatches.length) % paletteMatches.length);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (paletteActive >= 0) runPaletteAction(paletteMatches[paletteActive]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
});

// ---------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (ctrlOrCmd && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (isPaletteOpen()) closePalette();
    else openPalette();
  } else if (ctrlOrCmd && e.key === "Enter") {
    e.preventDefault();
    btnRun.click();
  } else if (ctrlOrCmd && e.key.toLowerCase() === "t") {
    e.preventDefault();
    createTab(`Script ${tabCounter + 1}`, "");
  } else if (ctrlOrCmd && e.key.toLowerCase() === "w") {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  } else if (e.key === "Escape") {
    if (isPaletteOpen()) closePalette();
    settingsOverlay.dataset.open = "false";
  }
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

loadSettings();
applyEditorSettings();
loadLibrary();
renderLibrary();

try {
  restoreTabs();
} catch (err) {
  console.error("restoreTabs failed, falling back to a blank tab", err);
  createTab("Script 1", DEFAULT_SCRIPT);
}

updateBreadcrumb();
pollProcessLive();

import type { LogEntry, ConsoleWindowState } from "../shared/ipc";

const body = document.getElementById("console-body")!;
const filterInput = document.getElementById("console-filter") as HTMLInputElement;
const collapseBtn = document.getElementById("console-collapse")!;
const closeBtn = document.getElementById("console-close-btn")!;
const clearBtn = document.getElementById("console-clear-btn")!;

const entries: LogEntry[] = [];

function buildLine(entry: LogEntry): HTMLElement {
  const line = document.createElement("div");
  line.className = `console-line ${entry.level}`;

  const time = document.createElement("span");
  time.className = "console-time";
  const d = new Date(entry.timestamp);
  time.textContent = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d
    .getSeconds()
    .toString()
    .padStart(2, "0")}`;

  const msg = document.createElement("span");
  msg.className = "console-msg";
  msg.textContent = entry.message;

  line.appendChild(time);
  line.appendChild(msg);
  return line;
}

function render(): void {
  const filter = filterInput.value.trim().toLowerCase();
  body.innerHTML = "";
  for (const entry of entries) {
    if (filter && !entry.message.toLowerCase().includes(filter)) continue;
    body.appendChild(buildLine(entry));
  }
  body.scrollTop = body.scrollHeight;
}

window.pulse.onLog((entry) => {
  entries.push(entry);
  if (entries.length > 500) entries.shift();

  const filter = filterInput.value.trim().toLowerCase();
  if (filter && !entry.message.toLowerCase().includes(filter)) return;

  body.appendChild(buildLine(entry));
  body.scrollTop = body.scrollHeight;
});

// The main process buffers every log line because this window's page
// loads asynchronously — anything logged (e.g. "Injecting into process…"
// right as the window first opens) before onLog above was registered
// would otherwise just be lost. onConsoleHistory delivers that backlog
// exactly once, right after this window signals it's actually ready to
// receive it — see consoleWindow.ts for the main-process side.
window.pulse.onConsoleHistory((history: LogEntry[]) => {
  entries.length = 0;
  entries.push(...history);
  render();
});
window.pulse.consoleReady();

filterInput.addEventListener("input", render);

clearBtn.addEventListener("click", () => {
  entries.length = 0;
  body.innerHTML = "";
});

collapseBtn.addEventListener("click", () => window.pulse.consoleToggleCollapse());
closeBtn.addEventListener("click", () => window.pulse.consoleClose());

window.pulse.onConsoleState((state: ConsoleWindowState) => {
  collapseBtn.classList.toggle("collapsed", state.collapsed);

  if (state.collapsed) {
    // Fade content out immediately as the window starts shrinking.
    body.classList.add("fading");
  } else {
    // Keep content hidden for the first stretch of the grow animation, then
    // fade it in — reads as a "reveal" instead of content being visibly
    // clipped while the window is still small.
    body.classList.add("fading");
    window.setTimeout(() => body.classList.remove("fading"), 70);
  }
});

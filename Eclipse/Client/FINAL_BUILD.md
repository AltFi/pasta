# Final packaged build — PulseExecutor.exe

`D:\Projects\Roblox\PulseExecutor-Dev8\Client\release\PulseExecutor.exe`
(84 MB, portable single-file build)

## What was fixed to get here

Electron's binary was never actually downloaded in this environment —
confirmed true for the ORIGINAL `Client/node_modules` too (`electron/dist/`
only had the license file, no `electron.exe`, no `path.txt`), so this
wasn't something introduced by the sandbox copy. `npm install`'s postinstall
step and a manual `node install.js` retry both failed silently to fetch it.

Worked around by downloading the binary directly — its actual host
(`github.com/electron/electron/releases`) was reachable even though
whatever `@electron/get` normally hits during `npm install` wasn't:

```
curl -L https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-win32-x64.zip
  -> extracted into node_modules/electron/dist/
  -> wrote node_modules/electron/path.txt = "electron.exe"
```

That's the same fix path `npm install` would have taken if the postinstall
download had succeeded — nothing was faked or stubbed, this is the real
188MB Electron binary matching the version already pinned in `package.json`.

## Verified, in order

1. `node -e "console.log(require('electron'))"` → resolves to the real
   `electron.exe` path.
2. `electron.exe .` (dev mode, unpackaged) → launched, spawned 5 processes
   (main + renderer + GPU + utility + network — normal Chromium
   multi-process layout), stayed alive for the full test window, no
   uncaught error from this project's own code.
3. `npm run dist` (electron-builder, portable target) → completed with no
   errors, produced `release\PulseExecutor.exe`.
4. `release/win-unpacked/resources/engine/` confirmed to actually contain
   `Module.dll` and `PulseInjector.exe` — the packaged build's
   `app.isPackaged` resource path
   (`injector.ts`: `process.resourcesPath/engine/`) resolves to real files,
   not a guess.
5. The packaged `PulseExecutor.exe` itself launched the same way as step 2
   — 5 processes, stayed alive, no crash from this project's code.

## What "verified" does NOT mean here

No GPU/display was available for a fully interactive check (`ERROR:
gpu_process_host.cc: GPU process exited unexpectedly` in the log — expected
and harmless in a session with no real display attached, not a bug in this
build). The window's actual visual layout, button click behavior, and a
live inject-against-a-real-Roblox-process run were not — and can't be —
exercised from here. What's confirmed is the whole pipeline builds,
packages, and launches cleanly end to end; the numbered list above is
exactly what was checked, not more.

## Post-build fix: console showed empty on first Inject click

Reported bug: the console window starts hidden, and the first time you
click Inject, the console opens but shows no log lines at all — they
"disappear somewhere."

Root cause, traced through the actual code: `revealConsole()` creates the
console `BrowserWindow` and calls `loadFile()`, which is asynchronous.
`main.ts`'s `InjectorRun` handler calls `sendLog(...)` immediately after
`revealConsole()` returns — before the console page has loaded and its
`console.ts` script has registered `window.pulse.onLog`. Electron's
`webContents.send()` does not queue messages for a not-yet-ready renderer;
a send with nothing listening on the other end is just gone. On the
second and later injects the window already exists and is already loaded,
so the same code path works fine — matching exactly what was reported
("only the first time").

Fixed with a ready-handshake instead of a delay/timeout hack: the main
process now keeps a rolling 500-entry log history
(`consoleWindow.ts`); `console.ts` registers its `onLog` listener first,
*then* signals `consoleReady()`; the main process replies with the full
history via a new `console:history` channel. Message ordering on a given
Electron IPC channel is preserved, so the history snapshot is guaranteed
to arrive before any live log sent after that point — no duplicate lines,
no race window. Rebuilt and repackaged — `release/PulseExecutor.exe` now
includes this fix.

## What's inside this build

- Engine: `сурсы/YuB-X-Module` dev pass 8 (Debug 10/10, Closures/Metatable/
  Environment complete, thread-safety fix, real TCP response ack).
- Injector: `madium.cpp` with real `--dll`/`--process`/`--pid` flag parsing
  and correct `RESULT:SUCCESS`/`RESULT:FAILURE` stdout markers.
- Client: rewired `protocol.ts`/`runtimeClient.ts` to the real wire format,
  `Stop`/heartbeat removed (no backend support for either), `Module.dll`
  filename corrected.

See each component's own `CHANGES.md` in `PulseExecutor-Dev8/` for the full
per-pass detail.

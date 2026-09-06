# Eclipse

<img width="957" height="540" alt="image" src="https://github.com/user-attachments/assets/d92a6a7a-e134-43ee-956a-1f2143242b9b" />

Roblox script executor. Portable Electron client (`PulseExecutor.exe`) injects a native
C++ DLL into `RobloxPlayerBeta.exe`. The DLL hooks `IDXGISwapChain::Present`, locates the
game's live `lua_State` through `ScriptContext`, and runs scripts through a self-contained
Luau VM.

## How it works

1. `injector.exe` (native, checked in under `Client/resources/`) is spawned by the client
   and injects `Module.dll` into the running Roblox process.
2. `Module.dll` installs a vtable hook on `IDXGISwapChain::Present`. All game-state-touching
   work happens from inside that hook, on Roblox's own render thread — it's the only place
   touching the live `lua_State`/`global_State` is safe.
3. On the first hooked frame, the DLL walks `DataModel -> ScriptContext` and resolves the
   engine's root `lua_State*` (`Roblox::GetLuaStateForInstance`).
4. A persistent child thread is created off that root state with `lua_newthread`, sandboxed,
   and reused for the whole session. Every queued script runs on it.
5. Scripts are compiled with the vendored Luau compiler and executed by a **vendored Luau
   VM built into the DLL** (`Dependencies/Luau`) — not Roblox's own `luau_execute`. This
   avoids needing Roblox's per-build opcode-scramble table.
6. `task.spawn`/`coroutine.*`/`task.wait` are implemented on top of real `lua_newthread` +
   `lua_resume` child threads, driven by a poll loop in the `Present` hook (`Task.hpp`,
   `TaskScheduler.cpp`).
7. Reflection/UNC-surface functions (`getgenv`, `hookfunction`, capability/identity
   spoofing, filesystem, encoding, crypto, console, input) live under
   `Pulse/Exploit/Environment/Libraries/`.

Communication between the Electron UI and the injected DLL goes through a local IPC channel
(`Communication.cpp` / `Client/src/main`), not shared memory or a socket to the internet.

## Known issues

**Foreign-thread crash under real workloads.** Trivial scripts (`print(...)`, a few dozen
bytes) run reliably. Scripts that exercise `task.spawn`/`coroutine.*` plus Roblox reflection
calls heavily (the UNC compliance suite) crash the host process, usually inside or shortly
after a `lua_resume` of one of our child threads.

What's confirmed so far:

- The crash is a genuine hardware access violation (`0xC0000005`, `DEP-EXECUTE`), not a Lua
  error — it happens deep in native code, not caught by a `pcall`.
- Registers at the fault (`RCX`, `RDX` specifically) are bit-identical across independent
  process launches despite ASLR, which is not consistent with a stray heap pointer — it
  points at a deterministic computation over bad/uninitialized data rather than random
  corruption.
- `RobloxPlayerBeta.exe`'s own `cb.userthread` callback write-faults immediately if allowed
  to run on a thread we created — its native thread-setup path expects state that only
  Roblox's own (currently unidentified) internal thread-creation wrapper establishes.
  Suppressing `cb.userthread` avoids that immediate crash but leaves our threads without
  whatever bookkeeping the real callback would have set up, which is the leading suspect
  for the delayed crash.
- Static disassembly of the installed Roblox binary is unreliable for locating this code —
  the executable ships Byfron/Hyperion anti-tamper sections and does not appear to match its
  on-disk bytes to what actually executes at runtime.
- Ruled out this pass: stack-buffer overflow (`/GS` re-enabled, fault code stayed
  `0xC0000005`, not `0xC0000409`), real stack overflow (`STATUS_STACK_OVERFLOW` never
  observed), and a stale hardcoded offset for `luaO_nilobject`/`dummynode` (swapping those to
  locally-linked sentinels changed nothing).

Next real step is a live comparison, under a debugger, of a genuine Roblox-created script
thread's `lua_State::userdata` against ours (all bytes, not just the one field currently
written to) — static analysis alone can't resolve it further given the anti-tamper
packing.

## Building

### Native engine (`Pulse/Pulse.vcxproj`)

Requires MSVC (Visual Studio 2022+, Desktop C++ workload) targeting `Release|x64`.

Dependencies are vendored under `Pulse/Dependencies/`:

- `Luau/` — vendored Luau VM/Compiler/Ast source, modified (see struct offset comments in
  `lstate.h`/`lobject.h`/`lua.h`)
- `lz4/`, `nlohmann/` — used by the bytecode/data layer

`http.request`/`HttpGet` are not performed inside the Roblox process — loading WinHTTP (or any
other non-Roblox DLL) into `RobloxPlayerBeta.exe` trips Hyperion's module checks and crashes the
game at injection. Instead the injected DLL forwards each request over a TCP connection to an HTTP
bridge in the Electron client (`Client/src/main/httpBridge.ts`, port 6970), which performs it with
Node's built-in `http`/`https` and streams back status/headers/cookies/body.

System libraries linked: `d3d11.lib`, `dxgi.lib`, `Dbghelp.lib`, plus standard
Win32 (`Ws2_32`, `Wldap32`, `Normaliz`, `Crypt32`, `Bcrypt`, `kernel32`, `user32`, `ole32`, ...).

```
MSBuild Pulse\Pulse.vcxproj /p:Configuration=Release /p:Platform=x64 /m
```

Output: `Pulse/x64/Release/Module.dll`. Copy it to `Client/resources/Module.dll` before
packaging the client.

### Client (Electron)

Requires Node.js 20+.

```
cd Client
npm install
npm run dist
```

Output: `Client/release/PulseExecutor.exe` (portable, self-extracting). `injector.exe` and
`Module.dll` are bundled from `Client/resources/`.

The portable build extracts to a per-version temp folder on first run; if you're iterating
on `Module.dll` and testing stale-looking behavior, clear `%TEMP%\<extraction folder>`
between packages.

## Layout

```
Pulse/                  native DLL (engine)
  Exploit/              hooking, scheduler, reflection library implementations
  Dependencies/Luau/    vendored VM/compiler
  Roblox/               offsets + signature-scan fallback table
Client/                 Electron app (UI, injector wrapper, IPC)
  resources/            injector.exe + built Module.dll (bundled into the package)
```

# YuB-X-Module → 99%+ UNC/SUNC: технический roadmap

Дата анализа: 24.08.2026
Метод: прямое чтение исходников `сурсы/YuB-X-Module` (Environment, Closures/Http/Miscellaneous, Execution, TaskScheduler, Yielding, Offsets, Encryptions, Communication) + web research по актуальному состоянию UNC/sUNC, Luau, Roblox runtime (2025–2026).

---

## 0. Главный вывод

`Engine/Runtime` и `YuB-X-Module` — две разные болезни.

`Engine/Runtime` был сломан на уровне **plumbing**: `getgenv()` возвращал nil всегда, потому что `lua_newtable` не резолвился. ~70 написанных функций были невидимы скрипту.

`YuB-X-Module` — **не эта проблема**. Фундамент здесь реальный и рабочий:

- `getgenv()` (`Miscellaneous.hpp:12-27`) — корректная реализация через выделенный `ExploitThread`, `luaC_threadbarrier` + `lua_xmove` для `LUA_GLOBALSINDEX`. Большинство наивных реализаций ломают это через GC barrier violation — здесь сделано правильно.
- `loadstring` (`Closures.hpp:14-32`) — реальный `luau_load`, реальная эскалация proto capabilities, реальный `lua_setsafeenv`.
- Execution pipeline (`Execution.cpp:22-76`) — реальный `Luau::compile` с кастомным `BytecodeEncoder`, который ремапит опкоды через `Offsets::OpcodeLookupTable` — это собственная opcode-обфускация Roblox, и она найдена и используется корректно, не угадана.
- `HttpGet`/`request` (`Http.hpp`) — реальный cpr/libcurl, корректный async yield-and-resume через `Yielding::YieldExecution` (воркер-поток + повторный вход через `Roblox::ScriptContextResume`).
- Хуки `__index`/`__namecall` на `game` (`Environment.cpp:116-140`) — реальный `clvalue()`-based swap `c.f`. Это тот самый рабочий путь, в отличие от мёртвой заглушки `EnvironmentHooks.cpp` в `Engine/Runtime`.

**Вывод: это не проблема plumbing. Это проблема breadth.** Фундамент держит нагрузку. Просто на нём стоит три библиотеки вместо двенадцати категорий.

---

## 1. Текущее покрытие по категориям sUNC

sUNC (docs.sunc.su) — поведенческий, server-signed тест-сьют, пришедший на смену дискредитированному presence-only UNC (discontinued 4 мая 2024). Его опубликованные категории и твоё текущее покрытие:

| Категория sUNC | Размер | Статус в YuB-X-Module | Файл |
|---|---|---|---|
| Closures | 11 | **1/11** — только `loadstring` | `Closures.hpp` |
| Debug | 10 | **0/10** | отсутствует |
| Filesystem | 10 | **0/10** | отсутствует |
| Reflection | 6 | **0/6** | нет `getgc`/`getreg` |
| Scripts | 8 | **0/8** | нет доступа к source/bytecode |
| Environment | 5+1 | **~2/6** — `getgenv` реален, `getrenv`/`getloadedmodules`/`filtergc` отсутствуют | `Miscellaneous.hpp` |
| Instances | 8 | **~1/8** — только `GetObjects`, и то через хук-интерсепт, не полноценный глобал | `Miscellaneous.hpp:44-73` |
| Metatable | 5 | **0/5** | отсутствует |
| Signals | 4 | **0/4** | отсутствует |
| Drawing | 4 | **0/4** | отсутствует |
| Encoding | 4 | **0/4** | отсутствует |
| Misc | 2 | **2/2** — `identifyexecutor`, `request` | `Miscellaneous.hpp`, `Http.hpp` |

Реально зарегистрировано скрипту (`Environment.cpp:146-157`): `loadstring`, `HttpGet`/`request`/`http_request`/`http.request`, `getgenv`, `identifyexecutor`, `getexecutorname`, плюс свежие `_G`/`shared`. Это всё. Отсюда и ~12% — две почти полные категории из двенадцати, остальное на нуле.

---

## 2. Точка хрупкости, которую надо закрыть раньше всего

`Roblox/Offsets.hpp` — **7 хардкод-констант** (`REBASE(0x1DEC8F0)` и т.п.). Ни сигнатурного сканера, ни fallback-механизма. На следующем апдейте Roblox весь модуль либо молча ломается, либо крашится — до ручного передампа.

`Encryptions.hpp` подтверждает: текущий билд Roblox Luau **шифрует ряд полей VM-структур** (`Proto::source`, `Proto::debuginsn`, debug-имя `Closure`, `TString::hash`, `lstate` stacksize, `Userdata::metatable`) через per-field ключи `VMValueN`. Ни одно из этих полей сейчас не расшифровывается — а именно они нужны почти всей категории **Debug** и большей части **Scripts**.

Это два отдельных, независимых блокера, и их нужно закрыть раньше breadth-работы — иначе Tier 3 просто невозможен физически, сколько функций ни пиши.

---

## 3. Roadmap по уровню leverage

### Tier 1 — инфраструктура: без этого всё остальное не переживёт следующий патч

**1.1. Сигнатурный сканер вместо хардкод-офсетов**
Заменить 7 констант в `Offsets.hpp` на pattern-scan (byte-signature + маска, с fallback по нескольким сигнатурам на функцию). Это не даёт очков UNC напрямую, но без этого шага любая последующая работа держится ровно до следующего Roblox update.

**1.2. Расшифровка VM-полей**
Найти и подключить расшифровку `VMValueN`-полей из `Encryptions.hpp` для: `Proto::source`, `Proto::debuginsn`, debug-имя закрытия, `TString::hash`, `Userdata::metatable`. Это единственный анлок, который делает категории **Debug** и **Scripts** вообще возможными — сейчас они не «не написаны», а структурно заблокированы, ровно как `getgenv` был заблокирован в `Engine/Runtime`.

**Leverage**: Tier 1 не двигает счётчик напрямую, но превращает Tier 3 из невозможного в «просто написать функции».

---

### Tier 2 — Closures: категория №1 у sUNC, гейтит всё, что завязано на хуки

**2.1. `newcclosure`**
Выделить реальный `Closure` с `isC=1` и trampoline-upvalue (та же схема, которую `Engine/Runtime` реализовал наполовину). У тебя здесь уже есть рабочий прямой вызов `lua_pcall` (используется в `Miscellaneous.hpp:44-73`) — то есть та половина, на которой споткнулся `Engine/Runtime` (forwarding call), здесь технической проблемой не является.

**2.2. `hookfunction`**
In-place патч `Closure` — сначала same-type (C↔C, L↔L), затем cross-type, используя обёртку из 2.1 как переходник между типами.

**2.3. `iscclosure`/`islclosure`, `getreg`, `getgc`, `checkcaller`**
`lgc.h` уже подключён в `Miscellaneous.hpp`, но не используется — обход GC-списка для `getgc` технически рядом. `checkcaller` — сравнение identity текущего треда с `ExploitThread` из `Globals.hpp:13`.

**2.4. `hookmetamethod`**
Обобщить уже доказанно рабочий паттерн `clvalue()`/`c.f`-swap из `InitializeHooks` (`Environment.cpp:116-140`) с хардкода на `game.__index`/`__namecall` до произвольной пары metatable/metamethod.

**Leverage**: Closures — крупнейшая категория sUNC и заявленная зависимость почти всего hook-based функционала выше по стеку. Это самый большой единичный прирост после Tier 1.

---

### Tier 3 — Debug, Scripts, Reflection (разблокируются Tier 1.2)

**3.1** `debug.getconstant(s)`, `getupvalue(s)`, `getinfo`, `setstack` — после расшифровки полей это уже механические обёртки вокруг декодированных структур `Proto`/`Closure`.

**3.2** `getscriptbytecode`/`getscriptclosure`-эквиваленты — зависят от того же расшифрованного `Proto::source`.

**Leverage**: без 1.2 — ноль. С 1.2 — почти чисто инженерная работа, без скрытых блокеров.

---

### Tier 4 — breadth, независимые leaf-функции

**4.1** `getrawmetatable`/`setrawmetatable`/`setreadonly`/`isreadonly` — обобщить metatable-хелпер, который уже неявно используется в `InitializeHooks`.

**4.2** `getinstances`/`getnilinstances`/`cloneref`/`compareinstances` — нужен обход живого instance-реестра Roblox (сейчас в кодовой базе не тронут вообще), не хардкод-путь `GetObjects`.

**4.3** Filesystem: `readfile`/`writefile`/`listfiles`/`isfile`/`isfolder`/`delfile`/`makefolder` — чистый Win32 file I/O, ноль зависимости от VM. Сейчас отсутствует полностью — это просто недописанная работа, самая дешёвая категория для быстрого закрытия.

**4.4** Encoding: `base64`, `lz4compress`/`decompress` — то же самое, leaf-функции без VM-зависимости.

**4.5** Signals/Drawing/WebSocket — низший приоритет: у sUNC это самые маленькие категории (4 члена каждая), и они завязаны на более специфичные Roblox object model, чем всё выше.

---

## 4. Итог: где реально двигается процент

- **Tier 1** — не даёт очков сам по себе, но без него Tier 3 физически невозможен, а весь модуль хрупок к любому Roblox-апдейту.
- **Tier 2 (Closures)** — самый большой единичный прирост: крупнейшая категория + фундаментальная зависимость для hook-based функций выше по стеку.
- **Tier 3** — полностью гейтится Tier 1.2, до этого — ноль прогресса, сколько ни пиши код.
- **Tier 4** — genuine breadth, никаких скрытых блокеров, тот случай, когда «просто добавь функции» наконец-то работает как стратегия — потому что фундамент (в отличие от `Engine/Runtime`) уже держит нагрузку.

Порядок исполнения: 1.1 → 1.2 → Tier 2 целиком → Tier 3 → Tier 4 (можно параллелить с Tier 2/3, зависимостей нет).

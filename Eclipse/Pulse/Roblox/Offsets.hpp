#pragma once

#include <cstdint>
#include <utility>
#include <Windows.h>

struct lua_State;
struct YieldState;
struct YieldingLuaThread;

#define REBASE(Address) (Address + reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr)))

// Roblox client version this offset set was dumped against:
// e7d81637d42c4b23 (Roblox 737, Fishstrap), verified statically on
// 2026-09-06 against RobloxPlayerBeta.exe (the process's MAIN module --
// REBASE() here uses GetModuleHandleA(nullptr), which is that exe, NOT the
// ~20MB RobloxPlayerBeta.dll companion; every RVA below was spot-checked to
// land in .text/.rdata/.data of the exe).
// Sources (both independently matched the same build):
//   - https://robloxoffsets.com/internal-offsets.hpp (Print, ScriptContextResume)
//   - a same-day dump shared by the user (2026-09-05) -- VisualEngine/TaskScheduler/
//     GlobalState/TLS/Luau/Instance/Datamodel layout.
// OLD constants for the previous generation (Print@0x92C340, FakeDataModelPointer@
// 0x8B79B58 ...) are proven stale for this build: the DataModel chain here moved
// from the scheduler-global slot to VisualEngine::Pointer -> FakeDatamodel -> Datamodel.
namespace Offsets
{
    const uintptr_t Print = REBASE(0x1C8A050);
    const uintptr_t OpcodeLookupTable = REBASE(0x6DA2370);
    const uintptr_t ScriptContextResume = REBASE(0x4115130);
    const uintptr_t GetLuaStateForInstance = REBASE(0x2219D10);

    // Modern identity path (fresh dump 2026-09-05): returns the CURRENT
    // thread's global_State* -- called from Roblox's own thread (SetupExploit
    // runs via PresentHook) it yields the canonical VM, G->mainthread being
    // the stable lua_State that RobloxState needs. GetLuaStateForInstance
    // (above) is ABSENT from both fresh dumps -- believed removed in the
    // 2025+ refactor -- and its legacy call crashes this build. Placed in
    // .text per static section check.
    namespace GlobalState
    {
        const uintptr_t GetGlobalState = REBASE(0x4077F80);
    }

    namespace Luau
    {
        const uintptr_t Luau_Execute = REBASE(0x26E4530);
        const uintptr_t LuaO_NilObject = REBASE(0x63516D8);
        const uintptr_t LuaH_DummyNode = REBASE(0x5FD6060);
    }

    namespace DataModel
    {
        const uintptr_t Children = 0x78;          // = Instance::Children in the fresh dump
        const uintptr_t GameLoadedStatus = 0x5D8; // = Datamodel::GameLoadedStatus; checked == 31 for game-loaded
        const uintptr_t ScriptContext = 0x440;
    }

    // DataModel chain in this build (fresh dump, 2026-09-05):
    //   VisualEngine = *(Pointer);              // global slot -> VE object
    //   FakeDataModel = *(VisualEngine + FakeDatamodel);
    //   DataModel     = *(FakeDataModel + Datamodel);
    namespace VisualEngine
    {
        const uintptr_t Pointer = REBASE(0x8351408);
        const uintptr_t FakeDatamodel = 0xAF0;
        const uintptr_t Datamodel = 0x1F8;
    }

    namespace ExtraSpace
    {
        const uintptr_t RequireBypass = 0x898;
        const uintptr_t ScriptContextToResume = 0x7E0;
    }
}

// Pulled in down here (not at the top) because PatternTable.hpp's own
// Table[] needs every Offsets::* constant above already defined to use as
// Fallback values. #pragma once makes this safe: PatternTable.hpp's own
// "#include <Roblox/Offsets.hpp>" resolves to a no-op re-entry (this file
// is already mid-include the first time this line runs), so it sees
// exactly the Offsets:: namespace content defined above this line.
#include <Roblox/PatternTable.hpp>

namespace Roblox
{
    // Resolved through Roblox::Patterns' signature scanner where a pattern
    // is filled in (see PatternTable.hpp), falling back to the REBASE()'d
    // constants above otherwise -- each Patterns::*() call caches its
    // result on first use. Tier 1.1 (signature scanning replacing
    // hardcoded offsets) is wired in here; see PatternTable.hpp for which
    // entries currently have a real pattern vs. still fall through.
    //
    // ROOT CAUSE of the 1114 (ERROR_DLL_INIT_FAILED) injection failure:
    // these four used to be `inline auto X = (FnPtr)Patterns::X();` --
    // namespace-scope `inline` variables with a non-constant initializer
    // still have static storage duration and are dynamically initialized
    // like any other global, which for a DLL means "runs during
    // DLL_PROCESS_ATTACH's global-constructor phase, before DllMain's own
    // body executes." That ran a full AOB byte-scan over the host
    // module's image (Patterns::Resolve -> Scanner::FindPatternInModule)
    // as part of static init -- unguarded by anything (Debug::Guard is
    // only ever called from inside MainThread, which hadn't started yet)
    // and ahead of InitLog(), so a crash there produces zero debug.log
    // output and surfaces to the injector purely as LoadLibrary/thread
    // failing with 1114. LazyFn below makes each of these a trivially
    // constructed (zero dynamic init) callable that only resolves+scans
    // on its first actual call site invocation -- by which point DllMain
    // has already returned, MainThread is running, InitLog() has already
    // run, and Resolve() itself is now SEH-guarded (see PatternTable.hpp)
    // so even a bad scan degrades to E.Fallback instead of crashing.
    template <typename FnPtr, uintptr_t(*Resolver)()>
    struct LazyFn
    {
        template <typename... Args>
        auto operator()(Args&&... args) const
        {
            static FnPtr Cached = reinterpret_cast<FnPtr>(Resolver());
            return Cached(std::forward<Args>(args)...);
        }
    };

    inline LazyFn<uintptr_t(*)(int, const char*, ...), &Roblox::Patterns::Print> Print;
    inline LazyFn<void(__fastcall*)(lua_State*), &Roblox::Patterns::LuauExecute> Luau_Execute;
    inline LazyFn<lua_State*(__fastcall*)(uint64_t, uint64_t*, uint64_t*), &Roblox::Patterns::GetLuaStateForInstance> GetLuaStateForInstance;
    inline LazyFn<uint64_t(__fastcall*)(uint64_t, YieldState*, YieldingLuaThread**, uint32_t, uint8_t, uint64_t), &Roblox::Patterns::ScriptContextResume> ScriptContextResume;
}

// Dont forget to update Encryptions and Structs
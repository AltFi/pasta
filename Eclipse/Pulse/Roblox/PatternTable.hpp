#pragma once

#include <string>
#include <cstdio>
#include <Roblox/Offsets.hpp>
#include <Roblox/SignatureScanner.hpp>
#include <Exploit/Debug/SafeCall.hpp>
#include <Exploit/Debug/Logger.hpp>

// -----------------------------------------------------------------------
// Additive layer over Offsets.hpp: resolve a value by signature scan when
// a pattern is available, falling back to the existing hardcoded constant
// otherwise. Does NOT replace or modify Offsets.hpp -- every existing
// REBASE()'d constant keeps working exactly as it does today if nothing
// here is wired in. This is purely opt-in scaffolding so patterns can be
// filled in incrementally (as they're actually reversed) without ever
// having a moment where the engine can't build or run.
//
// OPEN QUESTION, flagged rather than resolved unilaterally: Offsets.hpp's
// REBASE() macro rebases against `GetModuleHandleA(nullptr)` -- the
// process's main module. Engine/Injector/src/madium.cpp, elsewhere in
// this repo, explicitly targets a SEPARATE module by name
// ("RobloxPlayerBeta.dll") for its own patches. Whether Roblox's actual
// VM/game code lives in the main .exe or in a separate .dll -- and
// whether Offsets.hpp's existing constants are therefore rebased against
// the right module at all -- was not verified this pass. FindPatternIn*
// below defaults to nullptr (main module, matching Offsets.hpp's current
// behavior exactly) so nothing changes silently; pass an explicit module
// name once this is confirmed one way or the other.
// -----------------------------------------------------------------------
namespace Roblox::Patterns
{
    struct Entry
    {
        const char* Name;
        const char* Pattern;     // empty = not filled in yet, use Fallback
        const char* ModuleName;  // nullptr = main module (current Offsets.hpp behavior)
        int RipDisplacementOffset; // -1 = use the match address as-is
        int InstructionLength;     // only relevant if RipDisplacementOffset >= 0
        uintptr_t Fallback;
    };

    // A RIP-relative instruction (e.g. `lea reg, [rip+disp]`) needs the
    // match address resolved into the actual target it points at, not
    // just returned as-is.
    inline uintptr_t ResolveRipRelative(uintptr_t InstructionAddress, int DisplacementOffset, int InstructionLength)
    {
        int32_t Displacement = *reinterpret_cast<int32_t*>(InstructionAddress + DisplacementOffset);
        return InstructionAddress + InstructionLength + Displacement;
    }

    // Scan context/callback kept separate from Resolve() so the actual
    // memory read (FindPatternInModule walking a live module's image byte
    // by byte) runs behind Debug::Guard's SEH __try/__except. A pattern
    // that walks past a module's real committed pages (a bad SizeOfImage
    // read, a partially-mapped module because injection landed mid-load,
    // whatever) is a hardware access violation, not a C++ exception --
    // without this it takes the whole scan (and, transitively, whatever
    // called it) down uncaught. Combined with Offsets.hpp no longer
    // running this scan as global static initialization (see LazyFn
    // there), a bad scan now degrades to E.Fallback instead of turning
    // into ERROR_DLL_INIT_FAILED (1114) before DllMain even runs.
    struct ScanResult
    {
        const Entry* E;
        uintptr_t Out;
        bool Found;
    };

    inline void ScanGuarded(void* Ctx)
    {
        auto* R = static_cast<ScanResult*>(Ctx);
        auto Found = R->E->ModuleName ? Scanner::FindPatternInModule(R->E->ModuleName, R->E->Pattern)
                                       : Scanner::FindPatternInModule(nullptr, R->E->Pattern);
        if (Found)
        {
            R->Out = (R->E->RipDisplacementOffset >= 0)
                ? ResolveRipRelative(*Found, R->E->RipDisplacementOffset, R->E->InstructionLength)
                : *Found;
            R->Found = true;
        }
    }

    inline uintptr_t Resolve(const Entry& E)
    {
        if (E.Pattern && E.Pattern[0] != '\0')
        {
            ScanResult R{ &E, 0, false };
            bool Ok = Debug::Guard("SignatureScan", ScanGuarded, &R);

            if (Ok && R.Found)
            {
                Debug::Log("Resolve: '%s' pattern HIT, resolved=0x%llX, fallback would have been 0x%llX",
                    E.Name, static_cast<unsigned long long>(R.Out), static_cast<unsigned long long>(E.Fallback));
                return R.Out;
            }

            Debug::Log("Resolve: '%s' pattern %s -- falling back to hardcoded 0x%llX",
                E.Name, Ok ? "MISS (no match found)" : "CRASHED during scan (see [CRASH] line)",
                static_cast<unsigned long long>(E.Fallback));
        }

        return E.Fallback;
    }

    // -------------------------------------------------------------------
    // Table. Patterns below are sourced from a public, independently
    // maintained pattern set -- github.com/metixud/Roblox-Dumper
    // (Dump/Dumper/Metix.cpp), which targets the same functions by the
    // same names (ScriptContextResume, GetLuaStateForInstance, rbx_print,
    // OpcodeLookupTable, Luau_Execute, LuaO_NilObject, LuaH_DummyNode)
    // against RobloxPlayerBeta.exe's MAIN module -- confirming this
    // module's own REBASE(GetModuleHandleA(nullptr)) already targets the
    // right module, which was an open question in this file before this
    // pass. That repo's own README marks it "DISCONTINUED, lazy to update
    // it" -- these patterns are NOT verified against whatever specific
    // Roblox build is actually running when this loads, only carried over
    // from that public source as of this research pass (Aug 2026). Pattern
    // scans degrade more gracefully than a hardcoded address on a mismatch
    // (a compiler-emitted instruction sequence tends to survive more
    // updates than one specific absolute address), but a miss is still a
    // silent fallback to Offsets.hpp's own (also build-pinned) constant --
    // see the printf under PULSEEXECUTOR_VERBOSE_OFFSETS in Resolve() above
    // for how to see which one fired.
    //
    // "FakeDataModelPointer" left this table on 2026-09-06: the old
    // scheduler-global slot it pointed at (0x8B79B58 era) is proven stale
    // for the current build -- the root is now VisualEngine::Pointer ->
    // FakeDatamodel -> Datamodel, read directly in TaskScheduler::
    // GetDataModel (see Offsets.hpp's VisualEngine namespace). No pattern
    // and no entry needed for that chain.
    // -------------------------------------------------------------------
    inline const Entry Table[] = {
        // rbx_print: `call rbx_print` site -- E8 rel32 immediately followed
        // by a short jump and a known byte tail. Displacement is the 4
        // bytes right after the E8 opcode; call target = instr + 5 + rel.
        { "Print",                  "E8 ? ? ? ? EB ? 44 38 AE", nullptr, 1, 5, Offsets::Print },

        // LEA RCX, [rip+disp] immediately before the `call` that consumes
        // the opcode-scramble table; disp is at +3, LEA is 7 bytes long.
        { "OpcodeLookupTable",      "48 8D 0D ? ? ? ? E8 ? ? ? ? 4C 8B 5C 24", nullptr, 3, 7, Offsets::OpcodeLookupTable },

        // Function prologue byte sequences -- match address IS the entry
        // point, no RIP-relative resolution needed.
        { "ScriptContextResume",    "48 8B C4 44 89 48 20 4C 89 40 18 48 89 50 10 48 89 48 08 53", nullptr, -1, 0, Offsets::ScriptContextResume },
        { "GetLuaStateForInstance", "48 89 5C 24 ? 48 89 6C 24 ? 48 89 74 24 ? 57 48 83 EC ? 0F BE 15", nullptr, -1, 0, Offsets::GetLuaStateForInstance },
        { "LuauExecute",            "80 79 ? 00 0F 85 ? ? ? ? E9 ? ? ? ? ? 48 89 5C 24", nullptr, -1, 0, Offsets::Luau::Luau_Execute },

        // LEA R10/R11, [rip+disp] -- disp at +3, instruction is 7 bytes.
        { "NilObject",              "4C 8D 15 ? ? ? ? BF", nullptr, 3, 7, Offsets::Luau::LuaO_NilObject },
        { "DummyNode",              "4C 8D 1D ? ? ? ? 49 83 C6", nullptr, 3, 7, Offsets::Luau::LuaH_DummyNode },
    };

    // -----------------------------------------------------------------------
    // Named, cached accessors -- one per Table[] entry, in the same order.
    //
    // Resolve() itself is cheap to call twice (it's a linear byte scan over
    // a whole module), but there's no reason to redo that scan on every
    // single call site that wants, say, Print()'s address. Each accessor
    // resolves once (function-local static, thread-safe init in C++11+) and
    // returns the cached uintptr_t on every call after that -- same
    // one-time-then-cached shape Execution.cpp's own IsOpcodeTableSane()
    // already uses for its sanity check.
    //
    // This is the actual Tier 1.1 wiring: filling in a real Pattern above
    // is what moves a given entry onto scan-based resolution -- nothing
    // that calls these accessors needs to change again when a Pattern is
    // added, fixed, or removed.
    // -----------------------------------------------------------------------
    inline uintptr_t Print()                  { static uintptr_t V = Resolve(Table[0]); return V; }
    inline uintptr_t OpcodeLookupTable()      { static uintptr_t V = Resolve(Table[1]); return V; }
    inline uintptr_t ScriptContextResume()    { static uintptr_t V = Resolve(Table[2]); return V; }
    inline uintptr_t GetLuaStateForInstance() { static uintptr_t V = Resolve(Table[3]); return V; }
    inline uintptr_t LuauExecute()            { static uintptr_t V = Resolve(Table[4]); return V; }
    inline uintptr_t NilObject()              { static uintptr_t V = Resolve(Table[5]); return V; }
    inline uintptr_t DummyNode()              { static uintptr_t V = Resolve(Table[6]); return V; }
}

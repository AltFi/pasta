#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <optional>
#include <Windows.h>

// -----------------------------------------------------------------------
// Generic in-process AOB (array-of-bytes) signature scanner.
//
// This is standard, well-established PE-scanning infrastructure -- not
// Roblox-specific, and doesn't depend on any offset/signature this module
// doesn't already have. What it unlocks is Tier 1.1 from the original
// architecture review: right now every value in Offsets.hpp is a hardcoded
// module-relative constant that silently goes stale on the next Roblox
// update. A signature scanner turns "hardcoded address" into "pattern to
// search for," which survives address shifts as long as the surrounding
// instruction bytes don't change -- the actual reason public executors
// use this instead of hardcoded offsets.
//
// Runs entirely in-process against RobloxPlayerBeta.dll's own mapped
// memory (this module is loaded INSIDE that process once injected), so
// there's no ReadProcessMemory/cross-process complexity: the target
// module's code section is, by definition, readable+executable in this
// process's own address space, or the CPU couldn't run it either.
// -----------------------------------------------------------------------
namespace Roblox::Scanner
{
    struct ModuleBounds
    {
        uintptr_t Base = 0;
        size_t Size = 0;
        bool Valid = false;
    };

    inline ModuleBounds GetModuleBounds(HMODULE Module)
    {
        ModuleBounds Bounds;
        if (!Module)
            return Bounds;

        auto* Dos = reinterpret_cast<IMAGE_DOS_HEADER*>(Module);
        if (Dos->e_magic != IMAGE_DOS_SIGNATURE)
            return Bounds;

        auto* Nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(reinterpret_cast<uint8_t*>(Module) + Dos->e_lfanew);
        if (Nt->Signature != IMAGE_NT_SIGNATURE)
            return Bounds;

        Bounds.Base = reinterpret_cast<uintptr_t>(Module);
        Bounds.Size = Nt->OptionalHeader.SizeOfImage;
        Bounds.Valid = true;
        return Bounds;
    }

    // Finds a named PE section (e.g. ".text") within a module already
    // mapped into this process. Scanning just the code section instead of
    // the whole image is both faster and avoids false hits in data/rdata.
    inline ModuleBounds GetSectionBounds(HMODULE Module, const char* SectionName)
    {
        ModuleBounds Bounds;
        if (!Module)
            return Bounds;

        auto* Dos = reinterpret_cast<IMAGE_DOS_HEADER*>(Module);
        if (Dos->e_magic != IMAGE_DOS_SIGNATURE)
            return Bounds;

        auto* Nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(reinterpret_cast<uint8_t*>(Module) + Dos->e_lfanew);
        if (Nt->Signature != IMAGE_NT_SIGNATURE)
            return Bounds;

        auto* Section = IMAGE_FIRST_SECTION(Nt);
        for (WORD i = 0; i < Nt->FileHeader.NumberOfSections; ++i, ++Section)
        {
            if (strncmp(reinterpret_cast<const char*>(Section->Name), SectionName, 8) == 0)
            {
                Bounds.Base = reinterpret_cast<uintptr_t>(Module) + Section->VirtualAddress;
                Bounds.Size = Section->Misc.VirtualSize;
                Bounds.Valid = true;
                return Bounds;
            }
        }

        return Bounds;
    }

    // Pattern format: IDA-style hex bytes with "?" or "??" as a wildcard
    // byte, space-separated. e.g. "48 8B 05 ? ? ? ? 48 85 C0".
    struct ParsedPattern
    {
        std::vector<uint8_t> Bytes;
        std::vector<bool> Mask; // true = must match, false = wildcard
    };

    inline ParsedPattern ParsePattern(const std::string& Pattern)
    {
        ParsedPattern Result;

        size_t i = 0;
        while (i < Pattern.size())
        {
            while (i < Pattern.size() && Pattern[i] == ' ')
                ++i;
            if (i >= Pattern.size())
                break;

            if (Pattern[i] == '?')
            {
                Result.Bytes.push_back(0);
                Result.Mask.push_back(false);
                ++i;
                if (i < Pattern.size() && Pattern[i] == '?')
                    ++i; // consume the second '?' of "??" if present
            }
            else
            {
                std::string ByteStr = Pattern.substr(i, 2);
                Result.Bytes.push_back(static_cast<uint8_t>(strtoul(ByteStr.c_str(), nullptr, 16)));
                Result.Mask.push_back(true);
                i += 2;
            }
        }

        return Result;
    }

    // Every SignatureScan crash this session ([CRASH]/[VEH] stage=
    // SignatureScan, every single call, no exceptions) has the same
    // shape: RDX/region-size-like register reads 0x12000 consistently,
    // deterministic relative-offset crash regardless of ASLR base. Root
    // cause: this used to trust PE headers (SizeOfImage for the whole
    // module, VirtualSize for a section) as "this many bytes are safely
    // readable" and scan straight through with no verification --
    // reserved virtual address space is not the same guarantee as
    // committed+readable pages, and a module this size legitimately has
    // gaps (alignment padding between sections, and Hyperion/anti-tamper
    // are known from earlier this session to actively protect memory in
    // ways a naive scanner doesn't expect). Walking blindly off the end
    // of an actually-accessible sub-range is exactly what an access
    // violation this consistent looks like.
    //
    // Fix: VirtualQuery the target range ONCE up front, split it into the
    // sub-regions that are actually MEM_COMMIT + a readable protection,
    // and only ever scan (or let a candidate match's pattern length span)
    // within one such verified-safe sub-region. No more guessing whether
    // a given byte is safe to dereference.
    struct SafeRange
    {
        uintptr_t Start;
        size_t Size;
    };

    inline bool IsReadableProtect(DWORD Protect)
    {
        DWORD Base = Protect & 0xFF; // mask off PAGE_GUARD/PAGE_NOCACHE/PAGE_WRITECOMBINE modifier bits
        return Base == PAGE_READONLY || Base == PAGE_READWRITE || Base == PAGE_WRITECOPY ||
               Base == PAGE_EXECUTE_READ || Base == PAGE_EXECUTE_READWRITE || Base == PAGE_EXECUTE_WRITECOPY;
    }

    inline std::vector<SafeRange> GetSafeSubRanges(uintptr_t RegionStart, size_t RegionSize)
    {
        std::vector<SafeRange> Ranges;
        uintptr_t Cursor = RegionStart;
        uintptr_t End = RegionStart + RegionSize;

        while (Cursor < End)
        {
            MEMORY_BASIC_INFORMATION Mbi{};
            if (VirtualQuery(reinterpret_cast<LPCVOID>(Cursor), &Mbi, sizeof(Mbi)) == 0)
                break; // can't query past here at all -- stop, don't guess

            uintptr_t RegionEnd = reinterpret_cast<uintptr_t>(Mbi.BaseAddress) + Mbi.RegionSize;
            uintptr_t ClampedEnd = RegionEnd < End ? RegionEnd : End;

            if (Mbi.State == MEM_COMMIT && !(Mbi.Protect & PAGE_GUARD) && IsReadableProtect(Mbi.Protect) && ClampedEnd > Cursor)
                Ranges.push_back({ Cursor, ClampedEnd - Cursor });

            if (RegionEnd <= Cursor) // VirtualQuery returned something non-advancing -- avoid an infinite loop
                break;
            Cursor = RegionEnd;
        }

        return Ranges;
    }

    inline std::optional<uintptr_t> FindPattern(uintptr_t RegionStart, size_t RegionSize, const std::string& Pattern)
    {
        if (RegionStart == 0 || RegionSize == 0)
            return std::nullopt;

        ParsedPattern Parsed = ParsePattern(Pattern);
        if (Parsed.Bytes.empty() || Parsed.Bytes.size() > RegionSize)
            return std::nullopt;

        size_t PatternLen = Parsed.Bytes.size();

        for (const SafeRange& Range : GetSafeSubRanges(RegionStart, RegionSize))
        {
            if (Range.Size < PatternLen)
                continue;

            const uint8_t* Data = reinterpret_cast<const uint8_t*>(Range.Start);
            size_t Last = Range.Size - PatternLen;

            for (size_t offset = 0; offset <= Last; ++offset)
            {
                bool Match = true;
                for (size_t j = 0; j < PatternLen; ++j)
                {
                    if (Parsed.Mask[j] && Data[offset + j] != Parsed.Bytes[j])
                    {
                        Match = false;
                        break;
                    }
                }

                if (Match)
                    return Range.Start + offset;
            }
        }

        return std::nullopt;
    }

    // Same scan as FindPattern, but returns every match instead of just the
    // first -- for patterns generic enough that the first hit isn't
    // trustworthy on its own (see Execution.cpp's opcode-table candidate
    // search: the LEA+CALL shape here is common enough in a binary this
    // size that picking the first match blindly found the wrong site).
    inline std::vector<uintptr_t> FindAllPatterns(uintptr_t RegionStart, size_t RegionSize, const std::string& Pattern, size_t MaxResults = 64)
    {
        std::vector<uintptr_t> Results;
        if (RegionStart == 0 || RegionSize == 0)
            return Results;

        ParsedPattern Parsed = ParsePattern(Pattern);
        if (Parsed.Bytes.empty() || Parsed.Bytes.size() > RegionSize)
            return Results;

        size_t PatternLen = Parsed.Bytes.size();

        for (const SafeRange& Range : GetSafeSubRanges(RegionStart, RegionSize))
        {
            if (Range.Size < PatternLen)
                continue;

            const uint8_t* Data = reinterpret_cast<const uint8_t*>(Range.Start);
            size_t Last = Range.Size - PatternLen;

            for (size_t offset = 0; offset <= Last; ++offset)
            {
                bool Match = true;
                for (size_t j = 0; j < PatternLen; ++j)
                {
                    if (Parsed.Mask[j] && Data[offset + j] != Parsed.Bytes[j])
                    {
                        Match = false;
                        break;
                    }
                }

                if (Match)
                {
                    Results.push_back(Range.Start + offset);
                    if (Results.size() >= MaxResults)
                        return Results;
                }
            }
        }

        return Results;
    }

    inline std::vector<uintptr_t> FindAllPatternsInModule(const char* ModuleName, const std::string& Pattern, size_t MaxResults = 64)
    {
        HMODULE Module = GetModuleHandleA(ModuleName);
        ModuleBounds Bounds = GetModuleBounds(Module);
        if (!Bounds.Valid)
            return {};

        return FindAllPatterns(Bounds.Base, Bounds.Size, Pattern, MaxResults);
    }

    // A genuine opcode-scramble permutation table has a rare, checkable
    // fingerprint: every one of its 256 bytes is a DISTINCT value (it's a
    // bijection by construction -- every possible input byte must decode
    // to some output). Random data landing on "256 draws, zero duplicates"
    // has probability ~256!/256^256 (astronomically close to zero), so a
    // single-pass sliding-window duplicate count across a whole module
    // image finds the real table directly, independent of which
    // instruction (if any specific one at all) references it -- no
    // reliance on a possibly-stale instruction-byte pattern.
    inline std::vector<uintptr_t> FindFullPermutationWindows(uintptr_t RegionStart, size_t RegionSize, size_t MaxResults = 64)
    {
        std::vector<uintptr_t> Results;
        if (RegionStart == 0 || RegionSize < 256)
            return Results;

        for (const SafeRange& Range : GetSafeSubRanges(RegionStart, RegionSize))
        {
            if (Range.Size < 256)
                continue;

            const uint8_t* Data = reinterpret_cast<const uint8_t*>(Range.Start);
            int Count[256] = {};
            int DuplicateBytes = 0;

            for (size_t i = 0; i < 256; ++i)
            {
                uint8_t B = Data[i];
                if (++Count[B] == 2)
                    ++DuplicateBytes;
            }

            if (DuplicateBytes == 0)
            {
                Results.push_back(Range.Start);
                if (Results.size() >= MaxResults)
                    return Results;
            }

            for (size_t i = 256; i < Range.Size; ++i)
            {
                uint8_t Out = Data[i - 256];
                if (--Count[Out] == 1)
                    --DuplicateBytes;

                uint8_t In = Data[i];
                if (++Count[In] == 2)
                    ++DuplicateBytes;

                if (DuplicateBytes == 0)
                {
                    Results.push_back(Range.Start + (i - 255));
                    if (Results.size() >= MaxResults)
                        return Results;
                }
            }
        }

        return Results;
    }

    inline std::vector<uintptr_t> FindFullPermutationWindowsInModule(const char* ModuleName, size_t MaxResults = 64)
    {
        HMODULE Module = GetModuleHandleA(ModuleName);
        ModuleBounds Bounds = GetModuleBounds(Module);
        if (!Bounds.Valid)
            return {};

        return FindFullPermutationWindows(Bounds.Base, Bounds.Size, MaxResults);
    }

    // Convenience overload: scan a named module's whole image.
    inline std::optional<uintptr_t> FindPatternInModule(const char* ModuleName, const std::string& Pattern)
    {
        HMODULE Module = GetModuleHandleA(ModuleName);
        ModuleBounds Bounds = GetModuleBounds(Module);
        if (!Bounds.Valid)
            return std::nullopt;

        return FindPattern(Bounds.Base, Bounds.Size, Pattern);
    }

    // Convenience overload: scan a named module's named section only.
    inline std::optional<uintptr_t> FindPatternInSection(const char* ModuleName, const char* SectionName, const std::string& Pattern)
    {
        HMODULE Module = GetModuleHandleA(ModuleName);
        ModuleBounds Bounds = GetSectionBounds(Module, SectionName);
        if (!Bounds.Valid)
            return std::nullopt;

        return FindPattern(Bounds.Base, Bounds.Size, Pattern);
    }
}

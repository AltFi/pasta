// Pulse injector — carrier manual-mapper + Pool Party (user-APC) runtime.
//
// WORKING BACKGROUND:
//   * LoadLibrary injection -> Hyperion flags the DLL in the target's loader
//     module list -> "incompatible software" crash.
//   * Manual mapping + CreateRemoteThread -> module never enters the loader
//     list, but Hyperion terminates the freshly created remote thread with
//     STATUS_INVALID_THREAD (0xC000071C) BEFORE any payload instruction runs
//     (host stays alive). Verified empirically: a trivially mapped, no-CRT,
//     kernel32-only DllMain dies with 0xC000071C in Roblox yet runs perfectly
//     in a clean process (Notepad control).
//   * THE TECHNIQUE THAT WORKS (validated live against current Roblox):
//     eludorninj-style injection:
//       1. Suspend every Roblox thread.
//       2. Pick a random System32 DLL whose image maps to exactly 0x10000
//          bytes. Map that image, SEC_IMAGE, N consecutive 0x10000 views into
//          Roblox at a free aligned region => a contiguous "carrier" region
//          whose every page is owned by a legit image mapping.
//       3. Rewrite that region with our Module.dll (headers + sections) via
//          NtWriteVirtualMemory.
//       4. Resume threads.
//       5. Load a ~4KB loader blob into a fresh mapped view; give it the
//          carrier base plus LoadLibraryA/GetProcAddress pointers; it
//          resolves Module.dll's imports in-process, applies relocations,
//          sets page protections, and calls the image entry
//          (_DllMainCRTStartup -> full static CRT init -> DllMain).
//       6. Execute that loader on an EXISTING Roblox thread -- NOT via
//          CreateRemoteThread. Steal one of Roblox's IoCompletion handles
//          (NtQuerySystemInformation handle scan + NtQueryObject type check)
//          and post a completion packet with ZwSetIoCompletion whose kernel
//          APC impersonation runs our trampoline as a user-mode APC callback
//          on whichever Roblox thread is blocked in NtRemoveIoCompletion.
//          It runs in that thread's context; no new thread is ever created,
//          so Hyperion's thread-kill never fires.
//   * The loader reports progress through a status u32 at offset 0x18 of its
//     param block; status == 5 <=> "about to call the payload entry". This
//     injector waits for that before cleaning up and exiting 0.
//
// Exit codes (contracted with Client/src/main/injector.ts):
//   0  success
//   1  generic failure
//   2  needs elevation (OpenProcess denied; log contains an
//      "administrator"/"elevated" marker so the wrapper's needsElevation()
//      relaunches elevated)
// Progress goes to stderr (the Electron wrapper captures it).

#include <Windows.h>
#include <TlHelp32.h>
#include <KtmW32.h>
#include <winternl.h>

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "loader.h"

#pragma comment(lib, "KtmW32.lib")

namespace
{
    constexpr const char* DefaultTarget = "RobloxPlayerBeta.exe";

    void Log(const char* Format, ...)
    {
        va_list Args;
        va_start(Args, Format);
        vfprintf(stderr, Format, Args);
        fprintf(stderr, "\n");
        fflush(stderr);
        va_end(Args);
    }

    HMODULE g_NtDll = nullptr;

    using fn_ntcreatesection = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PLARGE_INTEGER, ULONG, ULONG, HANDLE);
    using fn_ntmapviewofsection = NTSTATUS(NTAPI*)(HANDLE, HANDLE, PVOID*, ULONG_PTR, SIZE_T, PLARGE_INTEGER, PSIZE_T, DWORD, ULONG, ULONG);
    using fn_ntunmapviewofsection = NTSTATUS(NTAPI*)(HANDLE, PVOID);
    using fn_ntwritevirtualmemory = NTSTATUS(NTAPI*)(HANDLE, PVOID, PVOID, SIZE_T, PSIZE_T);
    using fn_ntquerysysteminformation = NTSTATUS(NTAPI*)(ULONG, PVOID, ULONG, PULONG);
    using fn_ntqueryobject = NTSTATUS(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    using fn_zwsetiocomplete = NTSTATUS(NTAPI*)(HANDLE, PVOID, PVOID, NTSTATUS, ULONG_PTR);

    bool ReadFileBytes(const wchar_t* Path, std::vector<char>& Out)
    {
        HANDLE F = CreateFileW(Path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (F == INVALID_HANDLE_VALUE)
            return false;

        LARGE_INTEGER Sz{};
        GetFileSizeEx(F, &Sz);
        if (Sz.QuadPart <= 0 || Sz.QuadPart > 0x7FFFFFFF)
        {
            CloseHandle(F);
            return false;
        }

        Out.resize(static_cast<size_t>(Sz.QuadPart));
        DWORD Read = 0;
        BOOL Ok = ReadFile(F, Out.data(), static_cast<DWORD>(Out.size()), &Read, nullptr);
        CloseHandle(F);
        if (!Ok || Read != Out.size())
        {
            Out.clear();
            return false;
        }
        return true;
    }

    // Locates module.dll next to the injector (case-insensitive match).
    bool FindPayloadPath(std::wstring& Out)
    {
        wchar_t Self[MAX_PATH];
        if (GetModuleFileNameW(nullptr, Self, MAX_PATH) == 0)
            return false;

        wchar_t Dir[MAX_PATH];
        wcscpy_s(Dir, Self);
        wchar_t* Slash = wcsrchr(Dir, L'\\');
        if (!Slash)
            return false;
        *(Slash + 1) = L'\0';

        WIN32_FIND_DATAW fd{};
        HANDLE H = FindFirstFileW((std::wstring(Dir) + L"*.*").c_str(), &fd);
        if (H == INVALID_HANDLE_VALUE)
            return false;

        std::wstring Hit;
        do
        {
            if (fd.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_DEVICE))
                continue;
            if (_wcsicmp(fd.cFileName, L"module.dll") == 0)
            {
                Hit = std::wstring(Dir) + fd.cFileName;
                break;
            }
        } while (FindNextFileW(H, &fd));
        FindClose(H);

        if (Hit.empty())
            return false;
        Out = Hit;
        return true;
    }

    // Returns: 0 = opened, 1 = process not found, 2 = found but open denied
    // (elevation). On success *OutProc is a full-access handle.
    int OpenTarget(const wchar_t* TargetName, HANDLE& OutProc)
    {
        if (!TargetName || !*TargetName)
            TargetName = L"RobloxPlayerBeta.exe";

        wchar_t Need[MAX_PATH];
        wcscpy_s(Need, TargetName);

        HANDLE Snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (Snap == INVALID_HANDLE_VALUE)
            return 1;

        DWORD Pid = 0;
        PROCESSENTRY32W pe{};
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(Snap, &pe))
        {
            do
            {
                if (_wcsicmp(pe.szExeFile, Need) == 0)
                {
                    Pid = pe.th32ProcessID;
                    break;
                }
            } while (Process32NextW(Snap, &pe));
        }
        CloseHandle(Snap);

        if (Pid == 0)
            return 1;

        OutProc = OpenProcess(PROCESS_ALL_ACCESS, FALSE, Pid);
        if (!OutProc)
        {
            DWORD gle = GetLastError();
            // Access denied => the target is elevated and we are not.
            if (gle == ERROR_ACCESS_DENIED)
            {
                Log("injector: target is running elevated; run PulseExecutor as administrator");
                return 2;
            }
            return 1;
        }
        return 0;
    }

    void IterThreads(HANDLE Proc, bool Resume)
    {
        HANDLE Snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if (Snap == INVALID_HANDLE_VALUE)
            return;

        DWORD Pid = GetProcessId(Proc);
        THREADENTRY32 te{};
        te.dwSize = sizeof(te);
        if (Thread32First(Snap, &te))
        {
            do
            {
                if (te.th32OwnerProcessID != Pid)
                    continue;
                HANDLE T = OpenThread(THREAD_SUSPEND_RESUME, FALSE, te.th32ThreadID);
                if (!T)
                    continue;
                if (Resume) ResumeThread(T);
                else        SuspendThread(T);
                CloseHandle(T);
            } while (Thread32Next(Snap, &te));
        }
        CloseHandle(Snap);
    }

    void SuspendAll(HANDLE Proc) { IterThreads(Proc, false); }
    void ResumeAll(HANDLE Proc)  { IterThreads(Proc, true); }

    struct chunk
    {
        uintptr_t base;
        SIZE_T    size;
    };
    using chunk_map = std::map<int, chunk>;

    // A "carrier" is a System32 DLL that image-maps to exactly 0x10000 bytes.
    std::string GetCarrier()
    {
        WIN32_FIND_DATAA fd{};
        HANDLE h = FindFirstFileA("C:\\Windows\\System32\\*.dll", &fd);
        if (h == INVALID_HANDLE_VALUE)
            return {};

        auto ntcs  = (fn_ntcreatesection)    GetProcAddress(g_NtDll, "NtCreateSection");
        auto ntmvs = (fn_ntmapviewofsection) GetProcAddress(g_NtDll, "NtMapViewOfSection");
        auto ntumv = (fn_ntunmapviewofsection) GetProcAddress(g_NtDll, "NtUnmapViewOfSection");

        std::vector<std::string> candidates;
        do
        {
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
                continue;
            ULONGLONG sz = ((ULONGLONG)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
            if (sz == 0 || sz > 0x10000)
                continue;

            std::string path = std::string("C:\\Windows\\System32\\") + fd.cFileName;
            HANDLE file = CreateFileA(path.c_str(), GENERIC_READ | GENERIC_EXECUTE, FILE_SHARE_READ,
                                      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (file == INVALID_HANDLE_VALUE)
                continue;

            HANDLE sec = nullptr;
            NTSTATUS st = ntcs(&sec, SECTION_ALL_ACCESS, nullptr, nullptr, PAGE_READONLY, SEC_IMAGE, file);
            CloseHandle(file);
            if (st < 0)
                continue;

            PVOID  view = nullptr;
            SIZE_T viewsize = 0;
            st = ntmvs(sec, GetCurrentProcess(), &view, 0, 0, nullptr, &viewsize, 2, 0, PAGE_READONLY);
            CloseHandle(sec);
            if (st < 0)
                continue;

            bool keep = (viewsize == 0x10000);
            ntumv(GetCurrentProcess(), view);
            if (keep)
                candidates.push_back(path);

        } while (FindNextFileA(h, &fd));
        FindClose(h);

        if (candidates.empty())
            return {};
        return candidates[(size_t)rand() % candidates.size()];
    }

    uintptr_t BuildCarrier(HANDLE Proc, const std::string& CarrierPath,
                           SIZE_T PayloadSize, chunk_map& Chunks)
    {
        char TmpDir[MAX_PATH]  = {};
        char TmpFile[MAX_PATH] = {};
        GetTempPathA(MAX_PATH, TmpDir);
        GetTempFileNameA(TmpDir, "BYF", 0, TmpFile);

        if (!CopyFileA(CarrierPath.c_str(), TmpFile, FALSE))
        {
            DeleteFileA(TmpFile);
            return 0;
        }

        HANDLE File = CreateFileA(TmpFile, GENERIC_READ | GENERIC_EXECUTE,
                                  FILE_SHARE_READ | FILE_SHARE_DELETE,
                                  nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (File == INVALID_HANDLE_VALUE)
        {
            DeleteFileA(TmpFile);
            return 0;
        }

        int ChunkCount = (int)(((PayloadSize + 0xFFFF) >> 16) + 1);
        const SIZE_T kChunk = 0x10000;

        MEMORY_BASIC_INFORMATION mbi{};
        uintptr_t CarrierBase = 0;
        SIZE_T q = VirtualQueryEx(Proc, (LPCVOID)0x10000, &mbi, sizeof(mbi));
        while (q)
        {
            if (mbi.State == MEM_FREE)
            {
                uintptr_t Aligned = ((uintptr_t)mbi.BaseAddress + 0xFFFF) & ~(uintptr_t)0xFFFF;
                SIZE_T Need = (SIZE_T)ChunkCount * kChunk;
                if (mbi.RegionSize >= Need &&
                    Aligned + Need <= (uintptr_t)mbi.BaseAddress + mbi.RegionSize)
                {
                    CarrierBase = Aligned;
                    break;
                }
            }
            if ((uintptr_t)mbi.BaseAddress + mbi.RegionSize >= 0x7FFFFFFFFFFEULL)
                break;
            q = VirtualQueryEx(Proc, (LPCVOID)((uintptr_t)mbi.BaseAddress + mbi.RegionSize), &mbi, sizeof(mbi));
        }

        if (!CarrierBase)
        {
            CloseHandle(File);
            DeleteFileA(TmpFile);
            return 0;
        }

        auto ntcs  = (fn_ntcreatesection)      GetProcAddress(g_NtDll, "NtCreateSection");
        auto ntmvs = (fn_ntmapviewofsection)   GetProcAddress(g_NtDll, "NtMapViewOfSection");
        auto ntwvm = (fn_ntwritevirtualmemory) GetProcAddress(g_NtDll, "NtWriteVirtualMemory");

        int Mapped = 0;
        for (int i = 0; i < ChunkCount; ++i)
        {
            HANDLE Sec = nullptr;
            NTSTATUS st = ntcs(&Sec, SECTION_ALL_ACCESS, nullptr, nullptr, PAGE_READONLY, SEC_IMAGE, File);
            if (st < 0)
                continue;

            PVOID View = (PVOID)(CarrierBase + (uintptr_t)i * kChunk);
            SIZE_T ViewSize = 0;
            st = ntmvs(Sec, Proc, &View, 0, 0, nullptr, &ViewSize, 2, 0, PAGE_EXECUTE_READ);
            CloseHandle(Sec);
            if (st < 0)
                continue;

            DWORD Old = 0;
            VirtualProtectEx(Proc, View, kChunk, PAGE_EXECUTE_READWRITE, &Old);

            std::vector<uint8_t> Zeros(kChunk, 0);
            SIZE_T Wrote = 0;
            ntwvm(Proc, View, Zeros.data(), kChunk, &Wrote);

            Chunks[i] = chunk{ (uintptr_t)View, kChunk };
            ++Mapped;
        }
        CloseHandle(File);

        if (Mapped == 0)
            return 0;

        HANDLE Tx = CreateTransaction(nullptr, nullptr, 0, 0, 0, 0, nullptr);
        if ((uintptr_t)Tx - 1 <= 0xFFFFFFFFFFFFFFFDULL)
        {
            DeleteFileTransactedA(TmpFile, Tx);
            CommitTransaction(Tx);
            CloseHandle(Tx);
        }
        else
        {
            DeleteFileA(TmpFile);
        }

        return CarrierBase;
    }

    void WriteChunk(HANDLE Proc, const chunk_map& Chunks,
                    uintptr_t Dst, const void* Src, SIZE_T Size)
    {
        auto ntwvm = (fn_ntwritevirtualmemory) GetProcAddress(g_NtDll, "NtWriteVirtualMemory");
        if (!ntwvm)
            return;

        const uint8_t* P = (const uint8_t*)Src;
        while (Size > 0)
        {
            const chunk* Hit = nullptr;
            for (auto& KV : Chunks)
            {
                uintptr_t End = KV.second.base + KV.second.size;
                if (Dst >= KV.second.base && Dst < End)
                {
                    Hit = &KV.second;
                    break;
                }
            }
            if (!Hit)
                return;
            SIZE_T Avail = Hit->size - (Dst - Hit->base);
            SIZE_T N     = (Size <= Avail) ? Size : Avail;
            SIZE_T Wrote = 0;
            ntwvm(Proc, (PVOID)Dst, (PVOID)P, N, &Wrote);
            Dst  += N;
            P    += N;
            Size -= N;
        }
    }
}

// Carrier-based manual map. Returns the entry point address (base + EP) on
// success, 0 on failure. Suspends/resumes all target threads around the map.
static uintptr_t Oraclemap(HANDLE Proc, const std::vector<char>& Dll, uintptr_t& OutBase)
{
    OutBase = 0;

    std::string Carrier = GetCarrier();
    if (Carrier.empty())
        return 0;

    SuspendAll(Proc);

    auto Dos = (const IMAGE_DOS_HEADER*)Dll.data();
    if (Dll.empty() || Dos->e_magic != IMAGE_DOS_SIGNATURE)
    {
        ResumeAll(Proc);
        return 0;
    }
    auto Nt = (const IMAGE_NT_HEADERS64*)(Dll.data() + Dos->e_lfanew);
    if (Nt->Signature != IMAGE_NT_SIGNATURE)
    {
        ResumeAll(Proc);
        return 0;
    }

    chunk_map Chunks;
    uintptr_t Base = BuildCarrier(Proc, Carrier, Nt->OptionalHeader.SizeOfImage, Chunks);
    if (!Base)
    {
        ResumeAll(Proc);
        return 0;
    }

    WriteChunk(Proc, Chunks, Base, Dll.data(), Nt->OptionalHeader.SizeOfHeaders);

    auto Sec = IMAGE_FIRST_SECTION(Nt);
    for (WORD i = 0; i < Nt->FileHeader.NumberOfSections; ++i, ++Sec)
    {
        if (!Sec->SizeOfRawData)
            continue;
        WriteChunk(Proc, Chunks, Base + Sec->VirtualAddress,
                   Dll.data() + Sec->PointerToRawData, Sec->SizeOfRawData);
    }

    OutBase = Base;
    ResumeAll(Proc);
    return Base + Nt->OptionalHeader.AddressOfEntryPoint;
}

#pragma pack(push, 1)
struct ldr_param
{
    uintptr_t image_base;
    void*     load_library;
    void*     get_proc_address;
    uint64_t  status;
};

struct trampoline
{
    uint8_t   mov_rax[2];
    uintptr_t loader_addr;
    uint8_t   mov_rcx[2];
    uintptr_t param_addr;
    uint8_t   jmp_rax[2];
};
#pragma pack(pop)
static_assert(sizeof(trampoline) == 22, "trampoline size mismatch");

// Pool Party: steal an IoCompletion handle out of the target and queue a
// completion packet whose user-APC path runs `tramp` on an EXISTING target
// thread (the one blocked in NtRemoveIoCompletion). No new thread is created.
static void PoolParty(HANDLE Proc, const void* Tramp, SIZE_T TrampSize)
{
    auto ntqsi = (fn_ntquerysysteminformation) GetProcAddress(g_NtDll, "NtQuerySystemInformation");
    auto ntqo  = (fn_ntqueryobject)            GetProcAddress(g_NtDll, "NtQueryObject");
    auto zwsic = (fn_zwsetiocomplete)          GetProcAddress(g_NtDll, "ZwSetIoCompletion");
    if (!ntqsi || !ntqo || !zwsic)
        return;

    auto HandleBuf = (uint8_t*)operator new(100000);
    NTSTATUS St = ntqsi(51, HandleBuf, 100000, nullptr);
    if (St < 0)
    {
        operator delete(HandleBuf);
        return;
    }

    uint64_t Count = *(uint64_t*)HandleBuf;
    auto NameBuf = (uint8_t*)operator new(10000);
    ZeroMemory(NameBuf, 10000);

    HANDLE Stolen = nullptr;
    for (uint64_t i = 0; i < Count && !Stolen; ++i)
    {
        HANDLE Dup = nullptr;
        if (!DuplicateHandle(Proc, (HANDLE)(ULONG_PTR)i, GetCurrentProcess(),
                             &Dup, 0, FALSE, DUPLICATE_SAME_ACCESS))
            continue;
        if (ntqo(Dup, 2, NameBuf, 10000, nullptr) >= 0)
        {
            auto Buf = *(const wchar_t**)(NameBuf + 8);
            if (Buf && wcscmp(Buf, L"IoCompletion") == 0)
            {
                Stolen = Dup;
                break;
            }
        }
        CloseHandle(Dup);
    }
    operator delete(NameBuf);
    operator delete(HandleBuf);
    if (!Stolen)
        return;

    LPVOID TrampAddr = VirtualAllocEx(Proc, nullptr, TrampSize,
                                      MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!TrampAddr)
    {
        CloseHandle(Stolen);
        return;
    }

    SIZE_T Wrote = 0;
    if (!WriteProcessMemory(Proc, TrampAddr, Tramp, TrampSize, &Wrote) || Wrote != TrampSize)
    {
        VirtualFreeEx(Proc, TrampAddr, 0, MEM_RELEASE);
        CloseHandle(Stolen);
        return;
    }

    PVOID Landing = nullptr;
    MEMORY_BASIC_INFORMATION mbi{};
    uint8_t Scratch[0x1000];
    SIZE_T Q = VirtualQueryEx(Proc, nullptr, &mbi, sizeof(mbi));
    while (Q && !Landing)
    {
        if (mbi.State == MEM_COMMIT &&
            mbi.Protect == PAGE_READWRITE &&
            mbi.RegionSize >= 0x48)
        {
            SIZE_T Off = 0;
            while (Off + 0x48 <= mbi.RegionSize)
            {
                SIZE_T Cap    = mbi.RegionSize - Off - 0x47;
                SIZE_T ToRead = (Cap > 0x1000) ? 0x1000 : Cap;
                SIZE_T NRead  = 0;
                if (!ReadProcessMemory(Proc, (LPCVOID)((uintptr_t)mbi.BaseAddress + Off),
                                       Scratch, ToRead, &NRead))
                    break;
                if (NRead < 0x48)
                    break;
                for (SIZE_T j = 0; j + 0x48 <= NRead; ++j)
                {
                    bool AllZero = true;
                    for (SIZE_T k = 0; k < 0x48; ++k)
                    {
                        if (Scratch[j + k])
                        {
                            AllZero = false;
                            break;
                        }
                    }
                    if (AllZero)
                    {
                        Landing = (PVOID)((uintptr_t)mbi.BaseAddress + Off + j);
                        goto found;
                    }
                }
                Off += 0x1000;
            }
        }
        Q = VirtualQueryEx(Proc, (LPCVOID)((uintptr_t)mbi.BaseAddress + mbi.RegionSize),
                           &mbi, sizeof(mbi));
    }
found:
    if (!Landing)
    {
        CloseHandle(Stolen);
        return;
    }

    uint64_t Packet[9] = {};
    Packet[7] = (uint64_t)(uintptr_t)TrampAddr;
    WriteProcessMemory(Proc, Landing, Packet, sizeof(Packet), nullptr);
    zwsic(Stolen, Landing, nullptr, 0, 0);
    CloseHandle(Stolen);
}

// Wires up the loader blob and fires it via Pool Party. Returns false if any
// step fails outright; the injected loader posts progress through status at
// OutParamAddr (0x18, stages 1..5, 5 == "about to call payload entry").
static bool Trigger(HANDLE Proc, uintptr_t ImageBase, uintptr_t& OutParamAddr)
{
    auto ntcs  = (fn_ntcreatesection)    GetProcAddress(g_NtDll, "NtCreateSection");
    auto ntmvs = (fn_ntmapviewofsection) GetProcAddress(g_NtDll, "NtMapViewOfSection");
    if (!ntcs || !ntmvs)
        return false;

    HANDLE Sec = nullptr;
    LARGE_INTEGER MaxSize{};
    MaxSize.QuadPart = 0x1020;
    NTSTATUS St = ntcs(&Sec, 0xE, nullptr, &MaxSize, PAGE_EXECUTE_READWRITE, SEC_COMMIT, nullptr);
    if (St < 0)
        return false;

    PVOID View = nullptr;
    SIZE_T ViewSize = 0x1020;
    St = ntmvs(Sec, Proc, &View, 0, 0, nullptr, &ViewSize, 2, 0, PAGE_EXECUTE_READWRITE);
    if (St < 0)
    {
        CloseHandle(Sec);
        return false;
    }

    PVOID ParamAddr = (PVOID)((uintptr_t)View + 0x1000);

    WriteProcessMemory(Proc, View, loader, 0x1000, nullptr);

    HMODULE K32 = GetModuleHandleA("kernel32.dll");
    ldr_param Param{};
    Param.image_base       = ImageBase;
    Param.load_library     = GetProcAddress(K32, "LoadLibraryA");
    Param.get_proc_address = GetProcAddress(K32, "GetProcAddress");
    Param.status           = 0;
    WriteProcessMemory(Proc, ParamAddr, &Param, 0x20, nullptr);

    trampoline Tr{};
    Tr.mov_rax[0]  = 0x48; Tr.mov_rax[1]  = 0xB8;
    Tr.loader_addr = (uintptr_t)View;
    Tr.mov_rcx[0]  = 0x48; Tr.mov_rcx[1]  = 0xB9;
    Tr.param_addr  = (uintptr_t)ParamAddr;
    Tr.jmp_rax[0]  = 0xFF; Tr.jmp_rax[1]  = 0xE0;

    PoolParty(Proc, &Tr, sizeof(Tr));

    OutParamAddr = (uintptr_t)ParamAddr;
    CloseHandle(Sec);
    return true;
}

int wmain(int argc, wchar_t** argv)
{
    const wchar_t* Target = (argc > 1 && argv[1] && *argv[1]) ? argv[1] : nullptr;
    std::wstring TargetW = Target ? Target : L"RobloxPlayerBeta.exe";

    g_NtDll = GetModuleHandleA("ntdll.dll");

    std::wstring PayloadPath;
    if (!FindPayloadPath(PayloadPath))
    {
        Log("injector: payload 'module.dll' not found next to injector.exe");
        return 1;
    }

    std::vector<char> Dll;
    if (!ReadFileBytes(PayloadPath.c_str(), Dll) || Dll.empty())
    {
        Log("injector: cannot read payload 'module.dll'");
        return 1;
    }

    HANDLE Proc = nullptr;
    int Open = OpenTarget(TargetW.c_str(), Proc);
    if (Open == 1)
    {
        Log("injector: target process '%ls' not found -- is it running?", TargetW.c_str());
        return 1;
    }
    if (Open == 2)
    {
        Log("injector: cannot open '%ls' (access denied) -- injector requires elevated (administrator) privileges to open an elevated Roblox", TargetW.c_str());
        return 2;
    }

    Log("injector: targeting '%ls', payload module.dll (%zu bytes)", TargetW.c_str(), Dll.size());

    uintptr_t ImageBase = 0;
    uintptr_t Entry = Oraclemap(Proc, Dll, ImageBase);
    if (!Entry)
    {
        Log("injector: failed to map payload (carrier map)");
        CloseHandle(Proc);
        return 1;
    }
    Log("injector: mapped payload at 0x%llX, entry 0x%llX", (unsigned long long)ImageBase, (unsigned long long)Entry);

    uintptr_t ParamAddr = 0;
    if (!Trigger(Proc, ImageBase, ParamAddr))
    {
        Log("injector: failed to arm the loader (Pool Party trigger)");
        CloseHandle(Proc);
        return 1;
    }
    Log("injector: loader triggered via Pool Party (stolen IoCompletion), waiting for payload entry...");

    // The loader writes status stages 1..5 into param.status (offset 0x18);
    // 5 means the payload entry is about to be invoked. Cap the wait so a
    // dead trigger can't hang the client for its full 26s timeout.
    bool SawDone = false;
    for (int Tries = 0; Tries < 50; ++Tries)
    {
        Sleep(500);
        uint64_t Readback[4] = {};
        SIZE_T Got = 0;
        if (ReadProcessMemory(Proc, (LPCVOID)ParamAddr, Readback, 0x20, &Got) && Got == 0x20)
        {
            if ((uint32_t)Readback[3] == 5)
            {
                SawDone = true;
                break;
            }
        }
    }

    if (!SawDone)
    {
        Log("injector: payload entry was not reached (status handshake timed out) -- trigger may have been killed");
        CloseHandle(Proc);
        return 1;
    }

    CloseHandle(Proc);
    Log("injector: payload entry reached (status=5)");
    return 0;
}
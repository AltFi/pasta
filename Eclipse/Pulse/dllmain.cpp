#include <Exploit/Utils.hpp>
#include <Exploit/Globals.hpp>
#include <Communication/Communication.hpp>
#include <Exploit/TaskScheduler/TaskScheduler.hpp>
#include <Exploit/Debug/Logger.hpp>
#include <Exploit/Debug/SafeCall.hpp>
#include <Exploit/Debug/VectoredHandler.hpp>
#include <Roblox/PatternTable.hpp>

static void GetDataModelGuarded(void* OutPtr)
{
    *reinterpret_cast<uintptr_t*>(OutPtr) = TaskScheduler::GetDataModel();
}

static void CommunicationInitGuarded(void*)
{
    Communication::Initialize();
}

void MainThread()
{
    Debug::InitLog();
    Debug::Log("MainThread: started, module=%p", (void*)&MainThread);

    Debug::InstallVectoredHandler();
    Debug::Log("MainThread: process-wide VEH installed (logs [VEH] lines for any hardware fault anywhere in the process, not just inside Debug::Guard calls)");

    Debug::InstallTopLevelRecoveryFilter();
    Debug::Log("MainThread: top-level SetUnhandledExceptionFilter recovery backstop installed (catches faults Guard()'s own __except somehow misses -- see SafeCall.hpp)");

    // DIAGNOSTIC (2026-09-06): dumps every pattern resolution up front
    // (each accessor below triggers Resolve()'s own [Resolve:] log line) so
    // the actual loaded module base and which offsets HIT/MISS are visible
    // before any Roblox object is even touched. Also forces the LazyFn
    // caches to resident state here, on MainThread, rather than for the
    // first time mid-SetupExploit.
    Debug::Log("MainThread: bases -- process main module (exe)=0x%llX, our Module.dll=0x%llX, MainThread fn=%p",
        static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr))),
        static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(GetModuleHandleA("Module.dll"))),
        static_cast<void*>(&MainThread));
    Debug::Log("MainThread: resolved -- Print=0x%llX, OpcodeLookupTable=0x%llX, ScriptContextResume=0x%llX, GetLuaStateForInstance=0x%llX",
        static_cast<unsigned long long>(Roblox::Patterns::Print()),
        static_cast<unsigned long long>(Roblox::Patterns::OpcodeLookupTable()),
        static_cast<unsigned long long>(Roblox::Patterns::ScriptContextResume()),
        static_cast<unsigned long long>(Roblox::Patterns::GetLuaStateForInstance()));
    Debug::Log("MainThread: resolved -- LuauExecute=0x%llX, NilObject=0x%llX, DummyNode=0x%llX, GlobalState::GetGlobalState=0x%llX",
        static_cast<unsigned long long>(Roblox::Patterns::LuauExecute()),
        static_cast<unsigned long long>(Roblox::Patterns::NilObject()),
        static_cast<unsigned long long>(Roblox::Patterns::DummyNode()),
        static_cast<unsigned long long>(Offsets::GlobalState::GetGlobalState));

    // Communication::Initialize() spins up TcpServer() on its own detached
    // thread and returns immediately -- but if socket setup inside TcpServer
    // throws (WSAStartup/getaddrinfo/socket() are all capable of raising in
    // exotic environments) that exception unwinds on a thread this __try
    // can't see, so an SEH access violation is the only class of failure
    // this guard actually protects against directly. Real value here is
    // proving Initialize() itself was called and returned, which previous
    // debug.log runs (empty file, meaning DllMain never got this far) could
    // not distinguish from "TcpServer thread never started" without this
    // line existing on both sides of the call.
    if (!Debug::Guard("Communication::Initialize", CommunicationInitGuarded, nullptr))
    {
        Debug::Log("Communication::Initialize: guard reported failure -- TcpServer will not be listening on 6969");
    }
    Debug::Log("MainThread: Communication::Initialize returned, entering poll loop");

    while (true)
    {
        uintptr_t DataModel = 0;
        if (!Debug::Guard("GetDataModel", GetDataModelGuarded, &DataModel))
        {
            // GetDataModel crashed reading FakeDataModelPointer/FakeDataModelToDataModel --
            // Offsets::DataModel::FakeDataModelPointer or FakeDataModelToDataModel is wrong.
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            continue;
        }

        if (!DataModel)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            continue;
		}

        if (SharedVariables::LastDataModel != DataModel)
        {
            if (!Utils::IsInGame(DataModel))
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                continue;
            }
            {
                std::lock_guard<std::mutex> Lock(SharedVariables::ExecutionRequestsMutex);
                SharedVariables::ExecutionRequests.clear();
            }

            // SetupExploit is NOT called from here anymore. This whole
            // loop runs on MainThread -- a foreign OS thread Roblox never
            // created -- and lua_newthread/SetupEnvironment's GC
            // allocations racing Roblox's own thread on the same live
            // lua_State/global_State is exactly what was causing the
            // deterministic crash inside RobloxPlayerBeta.exe itself
            // (frealloc, correctly resolved, called from the wrong
            // thread). Instead: install a hook on Roblox's real
            // ScriptContextResume (called continuously by Roblox's own
            // task scheduler, on Roblox's own thread) and hand
            // SetupExploit off to it -- see TaskScheduler.cpp's
            // InstallResumeHook/ScriptContextResumeHook.
            if (!TaskScheduler::InstallExecutionHook())
            {
                Debug::Log("MainThread: InstallExecutionHook failed -- will retry in 1s");
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                continue;
            }

            Debug::Log("MainThread: starting (DataModel transitioned + IsInGame==true) -- handing SetupExploit off to PresentHook (Roblox's own thread)");
            SharedVariables::PendingDataModel = DataModel;
            SharedVariables::ExploitInitSucceeded = false;
            SharedVariables::ExploitInitPending = true;

            // Present is called every rendered frame, so this should flip
            // within a frame or two -- 5s is a generous ceiling for "the
            // hook isn't firing at all" rather than a normal wait.
            for (int WaitedMs = 0; WaitedMs < 5000 && SharedVariables::ExploitInitPending; WaitedMs += 50)
                std::this_thread::sleep_for(std::chrono::milliseconds(50));

            if (SharedVariables::ExploitInitPending)
            {
                Debug::Log("MainThread: PresentHook never fired within 5s (not rendering right now?) -- will retry in 1s");
                SharedVariables::ExploitInitPending = false;
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                continue;
            }

            if (!SharedVariables::ExploitInitSucceeded)
            {
                // Do NOT commit LastDataModel on failure -- a caught crash
                // meaning "never try again for this DataModel" permanently
                // would be worse than retrying every second for free.
                Debug::Log("MainThread: SetupExploit (ran on Roblox's own thread) failed, see [CRASH] line above -- will retry in 1s, not marking this DataModel as done");
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                continue;
            }

            SharedVariables::LastDataModel = DataModel;
            TaskScheduler::RequestExecution("print(\"Pulse successfully loaded\")");
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(1000));
    }
}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD  ul_reason_for_call, LPVOID lpReserved)
{
    if (ul_reason_for_call == DLL_PROCESS_ATTACH)
    {
        DisableThreadLibraryCalls(hModule);

        // Previously this was `std::thread(MainThread).detach();` with
        // nothing around it. std::thread's constructor calls CreateThread
        // internally and throws std::system_error on failure (e.g. the
        // loader lock held during DLL_PROCESS_ATTACH occasionally makes
        // CreateThread itself fail on some injection methods/AV hooks) --
        // an exception escaping DllMain during process attach is undefined
        // behavior and typically means the loader silently unlinks the
        // module with zero diagnostic output, which matches exactly what
        // was observed: injector.exe reports success (it only checks its
        // own exit code, never whether DllMain finished) while debug.log
        // never gets created because InitLog() -- the very first line of
        // MainThread -- never ran.
        try
        {
            std::thread(MainThread).detach();
        }
        catch (...)
        {
            // Can't rely on Debug::Log's normal path (it depends on
            // MainThread having called InitLog first), so open+write the
            // log directly here as a last resort.
            char AppData[MAX_PATH];
            DWORD Len = GetEnvironmentVariableA("APPDATA", AppData, MAX_PATH);
            std::string Dir = (Len > 0 && Len < MAX_PATH) ? std::string(AppData) + "\\PulseExecutor" : "C:\\PulseExecutor";
            CreateDirectoryA(Dir.c_str(), nullptr);
            std::string Path = Dir + "\\debug.log";
            FILE* F = nullptr;
            fopen_s(&F, Path.c_str(), "a");
            if (F)
            {
                fprintf(F, "[DllMain] FATAL: std::thread(MainThread) construction threw -- CreateThread failed during DLL_PROCESS_ATTACH\n");
                fclose(F);
            }
        }
    }

    return TRUE;
}
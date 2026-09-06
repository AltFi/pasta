#include <Windows.h>

// No CRT intentionally: entry point is DllMain itself (see
// EntryPointSymbol below), no global ctors, kernel32 API only. If this
// thread survives in the target while the _DllMainCRTStartup version dies,
// the problem is the CRT startup under a manually-mapped image, not the
// thread creation itself.

static const char* Marker = "C:\\Users\\AltFy\\AppData\\Local\\Temp\\opencode\\injtest\\marker.txt";

__declspec(noinline) BOOL APIENTRY DllMain(HMODULE, DWORD Reason, LPVOID)
{
    if (Reason != DLL_PROCESS_ATTACH)
        return TRUE;

    HANDLE F = CreateFileA(Marker, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (F != INVALID_HANDLE_VALUE)
    {
        char Buf[96];
        int Len = wsprintfA(Buf, "direct-dllmain ran on thread %lu\n", GetCurrentThreadId());
        DWORD Written = 0;
        WriteFile(F, Buf, (DWORD)Len, &Written, nullptr);
        CloseHandle(F);
    }
    return TRUE;
}
#include <Windows.h>
#include <cstdio>

static const char* Marker = "C:\\Users\\AltFy\\AppData\\Local\\Temp\\opencode\\injtest\\marker.txt";

static int CtorMarker()
{
    FILE* F = nullptr;
    fopen_s(&F, Marker, "a");
    if (F)
    {
        fprintf(F, "global-ctor ran on thread %lu\n", GetCurrentThreadId());
        fclose(F);
    }
    return 0;
}

static int g_Marker = CtorMarker();

BOOL APIENTRY DllMain(HMODULE, DWORD Reason, LPVOID)
{
    if (Reason == DLL_PROCESS_ATTACH)
    {
        FILE* F = nullptr;
        fopen_s(&F, Marker, "a");
        if (F)
        {
            fprintf(F, "dllmain ran on thread %lu\n", GetCurrentThreadId());
            fclose(F);
        }
    }
    return TRUE;
}
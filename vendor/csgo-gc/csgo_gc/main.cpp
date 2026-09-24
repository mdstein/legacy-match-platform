#include "stdafx.h"
#include "config.h"
#include "platform.h"
#include "steam_hook.h"

#if defined(_MSC_VER)
#define DLL_EXPORT extern "C" __declspec(dllexport)
#elif defined(__GNUC__)
#define DLL_EXPORT extern "C" __attribute__((visibility("default")))
#else
#error
#endif

DLL_EXPORT void InstallGC(bool dedicated)
{
    Platform::Initialize();
    Platform::Print("B2G local GC initialized (owned_only=%d, dedicated=%d)\n",
        GetConfig().OwnedOnly(), dedicated);
    SteamHookInstall(dedicated);
}

#include "client_runtime_win.h"
#include <cstdio>
#include <filesystem>

int wmain(int argc, wchar_t **argv)
{
    if (argc != 3) return 2;
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    const std::wstring bin = std::filesystem::absolute(argv[1]).wstring();
    std::wstring failed;
    const bool loaded = LoadClientIcu(bin, failed);
    if (!wcscmp(argv[2], L"missing"))
    {
        if (loaded || failed != bin + L"\\icuuc.dll") return 3;
        std::puts("Missing game runtime fails without falling back to Windows ICU.");
        return 0;
    }
    if (!loaded) { std::fwprintf(stderr, L"Load failed: %s (%lu)\n", failed.c_str(), GetLastError()); return 4; }
    for (const wchar_t *name : {L"icuuc.dll", L"icui18n.dll"})
    {
        wchar_t actual[MAX_PATH] = {};
        if (!GetModuleFileNameW(GetModuleHandleW(name), actual, MAX_PATH)
            || !std::filesystem::equivalent(actual, std::filesystem::path(bin) / name)) return 5;
    }
    using Version = int (*)();
    auto version = reinterpret_cast<Version>(GetProcAddress(GetModuleHandleW(L"icui18n.dll"), "B2gIcuFixtureConsumer"));
    if (!version || version() != 58) return 6;
    std::puts("Game-local ICU and its transitive dependency loaded from the same directory.");
    return 0;
}

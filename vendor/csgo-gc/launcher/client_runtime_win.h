#pragma once
#include <windows.h>
#include <string>

// Source loads parts of Panorama after the initial launcher DLL. Merely adding
// bin to PATH still puts Windows' incompatible icuuc.dll ahead of ICU 58.
// Load the complete game-local pair before Steam/Source can resolve that name.
// Keep these references for the process lifetime, just like the engine modules.
inline bool LoadClientIcu(const std::wstring &bin, std::wstring &failedPath)
{
    for (const wchar_t *name : {L"icuuc.dll", L"icui18n.dll"})
    {
        const std::wstring path = bin + L"\\" + name;
        if (!LoadLibraryExW(path.c_str(), nullptr,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32))
        {
            const DWORD error = GetLastError();
            failedPath = path;
            SetLastError(error);
            return false;
        }
    }
    return true;
}

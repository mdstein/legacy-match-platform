@echo off
setlocal
call "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -arch=x86 -host_arch=x64
if errorlevel 1 exit /b 1
cmake -S vendor\csgo-gc -B vendor\csgo-gc\build-b2g -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=%USERPROFILE%\vcpkg\scripts\buildsystems\vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x86-windows-static
if errorlevel 1 exit /b 1
cmake --build vendor\csgo-gc\build-b2g --target all -j 4
if errorlevel 1 exit /b 1
ctest --test-dir vendor\csgo-gc\build-b2g --output-on-failure -C Release
if errorlevel 1 exit /b 1
set "FINAL_PANORAMA=%B2G_FINAL_CODE_PBIN%"
if not defined FINAL_PANORAMA set "FINAL_PANORAMA=%ProgramFiles(x86)%\Steam\steamapps\common\csgo legacy\csgo\panorama\code.pbin"
if exist "%FINAL_PANORAMA%" (
  vendor\csgo-gc\build-b2g\csgo_gc\panorama_patch_tests.exe "%FINAL_PANORAMA%"
  if errorlevel 1 exit /b 1
  node scripts\test-b2g-popup-lifecycle.mjs
  if errorlevel 1 exit /b 1
)
exit /b 0

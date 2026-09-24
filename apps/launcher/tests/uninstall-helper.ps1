# Invoked only by the isolated Rust test. HKCU is a temporary filesystem drive;
# neither the real user registry nor an installed launcher can be changed.
$ErrorActionPreference='Stop'
$fixture=[IO.Path]::GetFullPath($env:B2G_UNINSTALL_FIXTURE)
if (-not $fixture -or (Split-Path -Leaf $fixture) -notmatch '^b2g-helper-test-\d+-\d+$') {throw 'Missing isolated fixture'}
$env:LOCALAPPDATA=Join-Path $fixture 'local'
$env:APPDATA=Join-Path $fixture 'roaming'
$env:TEMP=Join-Path $fixture 'temp'
$env:TMP=$env:TEMP
$registry=Join-Path $fixture 'registry'
New-Item -ItemType Directory -Path $env:TEMP,$registry -Force | Out-Null
Remove-PSDrive HKCU
New-PSDrive -Name HKCU -PSProvider FileSystem -Root $registry | Out-Null
$root=Join-Path $env:LOCALAPPDATA 'B2G'
$bin=Join-Path $root 'bin'
$programs=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Path $bin,$programs -Force | Out-Null
$launcher=Join-Path $bin 'b2g-launcher.exe'
[IO.File]::WriteAllText($launcher,'fixture executable')
$hasher=[Security.Cryptography.SHA256]::Create()
$env:B2G_UNINSTALL_SHA256=[BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($launcher))).Replace('-','').ToLowerInvariant()
$hasher.Dispose()
$personal=Join-Path $root 'launcher.json'
[IO.File]::WriteAllText($personal,'preserved settings')
$shell=New-Object -ComObject WScript.Shell
$shortcut=Join-Path $programs 'B2G Launcher.lnk'
$link=$shell.CreateShortcut($shortcut)
$link.TargetPath=$launcher
$link.Save()
$script=Join-Path $env:TEMP 'b2g-uninstall-123-456.ps1'
$env:B2G_UNINSTALL_READY=Join-Path $env:TEMP 'b2g-uninstall-123-456.ready'
$env:B2G_UNINSTALL_PARENT='2147483647'
Copy-Item -LiteralPath $env:B2G_UNINSTALL_SOURCE -Destination $script
[IO.File]::WriteAllText($env:B2G_UNINSTALL_READY,'ready')
if($env:B2G_UNINSTALL_TEST_MODE -eq 'changed') {
    [IO.File]::WriteAllText($launcher,'changed executable')
    $blocked=$false
    try { & $script -CheckOnly } catch {$blocked=$_.Exception.Message -like '*launcher changed*'}
    if(-not $blocked) {throw 'A changed launcher must fail before mutation'}
    if([IO.File]::ReadAllText($launcher) -ne 'changed executable' -or -not (Test-Path -LiteralPath $shortcut)) {throw 'Preflight changed installed files'}
} else {
    & $script
    if((Test-Path -LiteralPath $launcher) -or (Test-Path -LiteralPath $shortcut)) {throw 'Installed files remain'}
    if((Test-Path -LiteralPath $script) -or (Test-Path -LiteralPath $env:B2G_UNINSTALL_READY)) {throw 'Handoff files remain'}
}
if([IO.File]::ReadAllText($personal) -ne 'preserved settings') {throw 'Personal data changed'}
Write-Output 'Isolated B2G removal passed.'

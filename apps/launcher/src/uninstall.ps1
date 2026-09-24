param([switch]$CheckOnly)
$ErrorActionPreference='Stop'

function Assert-OrdinaryPath([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing a linked uninstall path: $cursor"
            }
        }
        $cursor=Split-Path -Parent $cursor
    }
}
function Assert-LauncherFile([string]$Path,[string]$ExpectedHash) {
    Assert-OrdinaryPath $Path
    if (Test-Path -LiteralPath $Path) {
        $hasher=[Security.Cryptography.SHA256]::Create()
        $stream=[IO.File]::OpenRead($Path)
        try {$actual=[BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
        finally {$stream.Dispose();$hasher.Dispose()}
        if ($ExpectedHash -notmatch '^[a-f0-9]{64}$' -or $actual -ne $ExpectedHash) {
            throw 'The installed launcher changed. Nothing was removed; retry from the current launcher.'
        }
    }
}
function Assert-Registration {
    Assert-OrdinaryPath $shortcut
    if (Test-Path -LiteralPath $commandKey) {
        if ((Get-Item -LiteralPath $commandKey).GetValue('') -ne $expectedCommand) {throw 'The b2g protocol points to another launcher. Its registration was left untouched.'}
    }
    if (Test-Path -LiteralPath $shortcut) {
        $shell=New-Object -ComObject WScript.Shell
        if ($shell.CreateShortcut($shortcut).TargetPath -ne $launcher) {throw 'The B2G shortcut points to another app. It was left untouched.'}
    }
}

$root=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'B2G'))
$bin=Join-Path $root 'bin'
$launcher=Join-Path $bin 'b2g-launcher.exe'
$shortcut=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\B2G Launcher.lnk'
$protocol='HKCU:\Software\Classes\b2g'
$commandKey=Join-Path $protocol 'shell\open\command'
$expectedCommand='"'+$launcher+'" protocol "%1"'
$ready=[IO.Path]::GetFullPath($env:B2G_UNINSTALL_READY)
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if (-not $ready.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($ready) -notmatch '^b2g-uninstall-\d+-\d+\.ready$') {throw 'Invalid removal handoff.'}
Assert-OrdinaryPath $root
Assert-OrdinaryPath $ready
$log=Join-Path $root 'logs\uninstall.log'
Assert-OrdinaryPath $log
Assert-LauncherFile $launcher $env:B2G_UNINSTALL_SHA256
Assert-Registration
if($CheckOnly) {Write-Output 'B2G removal preflight passed.';exit 0}
try {
    $deadline=[DateTime]::UtcNow.AddMinutes(2)
    while(-not (Test-Path -LiteralPath $ready)) {
        if ([DateTime]::UtcNow -ge $deadline) {throw 'Removal was not confirmed by the launcher.'}
        Start-Sleep -Milliseconds 100
    }
    $owner=Get-Process -Id ([int]$env:B2G_UNINSTALL_PARENT) -ErrorAction SilentlyContinue
    if ($owner -and -not $owner.WaitForExit(60000)) {throw 'The launcher is still open. Close it and retry uninstall.'}
    # Only named B2G files are removed. The game and personal data stay in place.
    Assert-LauncherFile $launcher $env:B2G_UNINSTALL_SHA256
    Assert-Registration
    if (Test-Path -LiteralPath $launcher) {Remove-Item -LiteralPath $launcher -Force}
    if (Test-Path -LiteralPath $shortcut) {Remove-Item -LiteralPath $shortcut -Force}
    if (Test-Path -LiteralPath $commandKey) {Remove-Item -LiteralPath $protocol -Recurse -Force}
    if ((Test-Path -LiteralPath $bin) -and -not (Get-ChildItem -LiteralPath $bin -Force)) {Remove-Item -LiteralPath $bin}
    New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null
    'B2G uninstalled. CS:GO, personal settings, demos and loadout were preserved.' | Set-Content -LiteralPath $log
} catch {
    New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null
    $_.Exception.Message | Set-Content -LiteralPath $log
    $shell=New-Object -ComObject WScript.Shell
    [void]$shell.Popup("B2G could not finish removal. $($_.Exception.Message)",0,'B2G uninstall',16)
} finally {
    if(Test-Path -LiteralPath $ready){Remove-Item -LiteralPath $ready -Force}
    Remove-Item -LiteralPath $PSCommandPath -Force
}

param(
    [switch]$Apply,
    [string]$GameRoot = 'C:\Program Files (x86)\Steam\steamapps\common\csgo legacy'
)
# Reset only the standalone CS:GO client and per-user launcher installation.
# Settings, demos, Steam userdata, online accounts and inventories are preserved.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$game = [IO.Path]::GetFullPath($GameRoot).TrimEnd('\')
$common = Split-Path -Parent $game
$steamapps = Split-Path -Parent $common
$steam = Split-Path -Parent $steamapps
$manifest = Join-Path $steamapps 'appmanifest_4465480.acf'
$launcherRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'B2G'))
$launcherBin = Join-Path $launcherRoot 'bin'
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\B2G Launcher.lnk'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$backup = Join-Path $workspace ".artifacts\clean-install-backup\$stamp"

function Assert-Within([string]$Child,[string]$Parent) {
    $resolvedChild = [IO.Path]::GetFullPath($Child)
    $resolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (-not $resolvedChild.StartsWith($resolvedParent,[StringComparison]::OrdinalIgnoreCase)) { throw "Path escaped its intended directory: $resolvedChild" }
}
Assert-Within $game $common
Assert-Within $backup (Join-Path $workspace '.artifacts\clean-install-backup')
Assert-Within $launcherBin $launcherRoot
if ((Split-Path -Leaf $common) -ne 'common' -or (Split-Path -Leaf $steamapps) -ne 'steamapps') { throw 'Expected a Steam common game directory.' }
if (-not (Test-Path -LiteralPath $manifest)) { throw 'Standalone App 4465480 manifest is required. App 730 / CS2 is never removed by this script.' }
$acf = Get-Content -LiteralPath $manifest -Raw
if ($acf -notmatch '"appid"\s+"4465480"' -or $acf -notmatch '"installdir"\s+"([^"]+)"') { throw 'Unexpected Steam manifest.' }
if ([IO.Path]::GetFullPath((Join-Path $common $Matches[1])) -ne $game) { throw 'Manifest and game directory disagree.' }
foreach ($directory in @($steam,$steamapps,$common,$game,$launcherRoot,$launcherBin)) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing a junction/symlink: $directory" }
}
function Get-PreservedGameFiles {
    $entries = @(Get-ChildItem -LiteralPath $game -Recurse -Force)
    if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Game contains a junction/symlink; inspect before resetting.' }
    $entries | Where-Object {
    -not $_.PSIsContainer -and (
        $_.FullName.StartsWith((Join-Path $game 'csgo\cfg\'),[StringComparison]::OrdinalIgnoreCase) -or
        ($_.DirectoryName -eq (Join-Path $game 'csgo_gc') -and
            ($_.Name -match '^b2g_loadout_\d+\.txt$' -or $_.Name -eq 'saved_item_shuffles.txt')) -or
        $_.Extension -in @('.dem','.dmx','.cfg') -or $_.Name -in @('video.txt','videodefaults.txt','gamestate_integration_b2g.cfg')
    )
    }
}
$preserve = @(Get-PreservedGameFiles)
if ((Test-Path -LiteralPath $launcherBin) -and (Get-ChildItem -LiteralPath $launcherBin -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { throw 'Launcher bin contains a junction/symlink; inspect before resetting.' }
$plan = [ordered]@{ gameRoot=$game; manifest=$manifest; launcherBin=$launcherBin; backup=$backup; preservedFiles=$preserve.Count; preservedBytes=($preserve | Measure-Object Length -Sum).Sum; steamUserdata='preserved in place'; launcherSettingsAndDemos='preserved in place'; apply=[bool]$Apply }
$plan | ConvertTo-Json
if (-not $Apply) { return }

# Stop only processes whose executable paths belong to the named game/launcher.
$targets = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and (
        $_.ExecutablePath.StartsWith($game+'\',[StringComparison]::OrdinalIgnoreCase) -or
        $_.ExecutablePath.StartsWith($launcherBin+'\',[StringComparison]::OrdinalIgnoreCase) -or
        ($_.Name -like 'b2g-launcher*.exe' -and $_.ExecutablePath.StartsWith($workspace+'\',[StringComparison]::OrdinalIgnoreCase))
    )
})
foreach ($targetProcess in $targets) {
    $running = Get-Process -Id $targetProcess.ProcessId -ErrorAction SilentlyContinue
    if ($running) { [void]$running.CloseMainWindow() }
}
$closeDeadline = [DateTime]::UtcNow.AddSeconds(8)
do {
    $remaining = @($targets | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    if (-not $remaining) { break }
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $closeDeadline)
foreach ($running in $remaining) { Stop-Process -Id $running.Id -Force -ErrorAction Stop }
$steamExe = Join-Path $steam 'steam.exe'
Start-Process -FilePath $steamExe -ArgumentList '-shutdown' -WindowStyle Hidden
$deadline = [DateTime]::UtcNow.AddSeconds(40)
while (Get-Process -Name steam -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Steam did not stop; no files have been deleted.' }
    Start-Sleep -Milliseconds 250
}

# Collect again after shutdown: the game can flush a new config or demo on exit.
$preserve = @(Get-PreservedGameFiles)
$plan['preservedFiles'] = $preserve.Count
$plan['preservedBytes'] = ($preserve | Measure-Object Length -Sum).Sum
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath $manifest -Destination (Join-Path $backup 'original-appmanifest_4465480.acf')
$receipt = @()
foreach ($file in $preserve) {
    Assert-Within $file.FullName $game
    $relative = $file.FullName.Substring($game.Length + 1)
    $copy = Join-Path $backup "game\$relative"
    Assert-Within $copy $backup
    New-Item -ItemType Directory -Path (Split-Path -Parent $copy) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $copy
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    if ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ne $hash) { throw "Backup mismatch: $relative" }
    $receipt += [ordered]@{ path=$relative; bytes=$file.Length; sha256=$hash }
}
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backup 'preserved-files.json') -Encoding utf8
# All destructive paths are literal, absolute, validated above, and remain in
# this PowerShell process. Re-check immediate targets after backup completion.
Assert-Within $game $common
Assert-Within $launcherBin $launcherRoot
Remove-Item -LiteralPath $game -Recurse -Force
Remove-Item -LiteralPath $manifest -Force
# Put personal files back without a game executable or Steam install manifest.
foreach ($item in $receipt) {
    $target = Join-Path $game $item.path
    Assert-Within $target $game
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $backup "game\$($item.path)") -Destination $target
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $item.sha256) { throw "Restore mismatch: $($item.path)" }
}
if (Test-Path -LiteralPath $launcherBin) { Remove-Item -LiteralPath $launcherBin -Recurse -Force }
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
$protocol='HKCU:\Software\Classes\b2g'
if (Test-Path -LiteralPath $protocol) { Remove-Item -LiteralPath $protocol -Recurse -Force }
if ((Test-Path -LiteralPath (Join-Path $game 'csgo.exe')) -or (Test-Path -LiteralPath $manifest)) { throw 'Game installation reset is incomplete.' }
$plan['completedAt']=[DateTime]::UtcNow.ToString('o')
$plan | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'reset-receipt.json') -Encoding utf8
Write-Output "Clean-install test is ready. Preserved files verified at $backup"

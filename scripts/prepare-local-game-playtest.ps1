param(
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
function Get-FileDigest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cargo = Get-Content -LiteralPath (Join-Path $workspace 'apps\launcher\Cargo.toml') -Raw
$versionMatch = [regex]::Match($cargo, '(?m)^version\s*=\s*"(\d+\.\d+\.\d+)"\s*$')
if (-not $versionMatch.Success) { throw 'Could not resolve the launcher release version.' }
$version = $versionMatch.Groups[1].Value
$release = Join-Path $workspace "apps\web\public\downloads\b2g-launcher-v$version-windows-x86_64.exe"
$checksum = (Get-Content -LiteralPath "$release.sha256" -Raw).Trim()
$expectedFileName = [IO.Path]::GetFileName($release)
if ($checksum -notmatch ('^([a-f0-9]{64})\s+' + [regex]::Escape($expectedFileName) + '$')) {
    throw 'The launcher release checksum is malformed or names another file.'
}
$expectedHash = $Matches[1]
if ((Get-FileDigest $release) -ne $expectedHash) {
    throw 'The launcher release does not match its checked-in checksum.'
}

function Invoke-LauncherJson([string]$Command) {
    $output = & $release $Command --json
    if ($LASTEXITCODE -ne 0) { throw "Launcher $Command failed." }
    # Released alpha launchers also print their human-readable status to stdout.
    # Drop only that known prefix; malformed/unexpected output still fails JSON parsing.
    return (($output | Where-Object { $_ -notmatch '^\[B2G\] ' }) -join "`n") | ConvertFrom-Json
}

function Get-GameProcesses {
    # No command lines, window titles, tokens, or unrelated processes are recorded.
    return @(Get-Process -Name csgo,b2g-launcher -ErrorAction SilentlyContinue | ForEach-Object {
        [ordered]@{
            name = $_.ProcessName
            pid = $_.Id
            sessionId = $_.SessionId
            hasWindow = $_.MainWindowHandle -ne 0
        }
    })
}

$doctor = Invoke-LauncherJson 'doctor'
if (-not $doctor.legacyReady) { throw 'Legacy CS:GO is not installed and ready. No files changed.' }
$diagnostics = Invoke-LauncherJson 'diagnostics'
$installed = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'B2G\bin\b2g-launcher.exe'
$gameRoot = [IO.Path]::GetFullPath($doctor.gameRoot)
$processes = @(Get-GameProcesses)
$before = [ordered]@{
    installedLauncherSha256 = Get-FileDigest $installed
    gcLibrarySha256 = Get-FileDigest (Join-Path $gameRoot 'csgo_gc\csgo_gc.dll')
    gcWrapperMatches = $diagnostics.gcWrapperInstalled
    gcLibraryMatches = $diagnostics.gcLibraryInstalled
    valveLauncherBackupPresent = $diagnostics.originalLauncherBackup
    processes = $processes
}

$runRoot = Join-Path $workspace ('.artifacts\game-client-uat\' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
$reportPath = Join-Path $runRoot 'preflight.json'
$report = [ordered]@{
    checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
    expectedLauncherVersion = $version
    expectedLauncherSha256 = $expectedHash
    appId = $doctor.appId
    clientVersion = $doctor.currentClientVersion
    gameRoot = $gameRoot
    installedLauncher = $installed
    before = $before
    applied = $false
    desktopControl = 'not-verified-by-this-script'
    gameTest = 'not-run'
    reportPath = $reportPath
}

try {
    if ($Apply) {
        if ($processes.Count -ne 0) {
            throw 'CS:GO or B2G is already running. No existing process will be stopped or overwritten.'
        }
        if (-not $diagnostics.originalLauncherBackup) {
            throw 'The recoverable Valve launcher backup is missing. Refusing to repair this installation.'
        }
        $backupRoot = Join-Path $runRoot 'before-install'
        New-Item -ItemType Directory -Path $backupRoot | Out-Null
        $filesToBackUp = @(
            @{ source = $installed; name = 'b2g-launcher.exe' },
            @{ source = (Join-Path $gameRoot 'csgo.exe'); name = 'csgo.exe' },
            @{ source = (Join-Path $gameRoot 'csgo_gc\csgo_gc.dll'); name = 'csgo_gc.dll' },
            @{ source = (Join-Path $gameRoot 'csgo_gc\config.txt'); name = 'config.txt' }
        )
        foreach ($file in $filesToBackUp) {
            if (Test-Path -LiteralPath $file.source -PathType Leaf) {
                $destination = Join-Path $backupRoot $file.name
                Copy-Item -LiteralPath $file.source -Destination $destination
                if ((Get-FileDigest $file.source) -ne (Get-FileDigest $destination)) {
                    throw 'Pre-install backup failed verification.'
                }
            }
        }
        $report.backupRoot = $backupRoot
        # Recheck immediately before modifying files. Never kill a user's process.
        if (@(Get-GameProcesses).Count -ne 0) { throw 'Game or launcher started during preflight; install cancelled.' }
        & $release install
        if ($LASTEXITCODE -ne 0) { throw 'Per-user launcher installation failed.' }
        & $release game-repair
        if ($LASTEXITCODE -ne 0) { throw 'Managed local-GC repair failed.' }
        $report.applied = $true
    }
    $afterDiagnostics = Invoke-LauncherJson 'diagnostics'
    $report.after = [ordered]@{
        installedLauncherSha256 = Get-FileDigest $installed
        gcLibrarySha256 = Get-FileDigest (Join-Path $gameRoot 'csgo_gc\csgo_gc.dll')
        gcWrapperMatches = $afterDiagnostics.gcWrapperInstalled
        gcLibraryMatches = $afterDiagnostics.gcLibraryInstalled
        valveLauncherBackupPresent = $afterDiagnostics.originalLauncherBackup
        processes = @(Get-GameProcesses)
    }
    $report.localFilesReady = $report.after.installedLauncherSha256 -eq $expectedHash `
        -and $report.after.gcWrapperMatches -and $report.after.gcLibraryMatches `
        -and $report.after.valveLauncherBackupPresent
    if (-not $report.localFilesReady) { throw 'Local files differ from the selected release. Inspect the preflight report.' }
}
catch {
    $report.failure = $_.Exception.Message
    throw
}
finally {
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Write-Output ($report | ConvertTo-Json -Depth 6)
}

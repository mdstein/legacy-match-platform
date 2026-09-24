param(
    [Parameter(Mandatory)] [string]$Version,
    [Parameter(Mandatory)] [string]$ReleaseRoot,
    [Parameter(Mandatory)] [string]$CredentialsFile,
    [string]$StateRoot = "C:\ProgramData\Aftertick",
    [switch]$SkipServerDownload,
    [switch]$SkipFirewall,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
    throw "Version must be a semantic release identifier."
}

$source = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
$credentialsSource = [IO.Path]::GetFullPath($CredentialsFile)
$root = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
if ([IO.Path]::GetPathRoot($root).TrimEnd('\') -eq $root) {
    throw "StateRoot cannot be a drive root."
}
$manifestPath = Join-Path $source 'release-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Release manifest is missing.'
}
$releaseManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($releaseManifest.version -ne $Version -or -not $releaseManifest.files) {
    throw 'Release manifest version does not match the requested installation.'
}

function Get-ReleaseSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Assert-ReleaseFiles([string]$Directory) {
    $prefix = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
    $seen = @{}
    foreach ($entry in $releaseManifest.files) {
        if ($entry.path -notmatch '^[a-zA-Z0-9._/-]+$' -or $entry.path.Contains('..') -or $entry.path.StartsWith('/')) {
            throw 'Release manifest contains an unsafe file path.'
        }
        $file = [IO.Path]::GetFullPath((Join-Path $Directory $entry.path.Replace('/', '\')))
        if (-not $file.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $seen.ContainsKey($file)) {
            throw 'Release manifest contains a duplicate or escaped file path.'
        }
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
            (Get-Item -LiteralPath $file).Length -ne [long]$entry.sizeBytes -or
            (Get-ReleaseSha256 $file) -ne $entry.sha256) {
            throw "Release checksum mismatch: $($entry.path)"
        }
        $seen[$file] = $true
    }
    foreach ($file in Get-ChildItem -LiteralPath $Directory -File -Recurse) {
        if ($file.FullName -ne (Join-Path $Directory 'release-manifest.json') -and -not $seen.ContainsKey($file.FullName)) {
            throw 'Release contains an unmanifested file.'
        }
    }
    if ((Get-ReleaseSha256 (Join-Path $Directory 'release-manifest.json')) -ne
        (Get-ReleaseSha256 $manifestPath)) {
        throw 'Installed release manifest differs from the selected release.'
    }
}
Assert-ReleaseFiles $source
$requiredReleaseFiles = @(
    "apps\node-agent\dist\main.js",
    "artifacts\sourcemod\aftertick_match.smx",
    "artifacts\sourcemod\smac\plugins\smac.smx",
    "artifacts\sourcemod\smac\plugins\smac_aimbot.smx",
    "artifacts\sourcemod\smac\plugins\smac_autotrigger.smx",
    "artifacts\sourcemod\smac\plugins\smac_eyetest.smx",
    "artifacts\sourcemod\smac\plugins\smac_speedhack.smx",
    "artifacts\sourcemod\smac\plugins\smac_spinhack.smx",
    "artifacts\sourcemod\smac\translations\smac.phrases.txt",
    "deploy\hosts\windows\Start-AftertickGameNode.ps1",
    "infra\game-server\cfg\server.cfg",
    "infra\game-server\cfg\smac.cfg",
    "infra\game-server\gc\config.txt",
    "vendor\csgo-gc\LICENSE",
    "vendor\csgo-gc\prebuilt\windows-x86\srcds.exe",
    "vendor\csgo-gc\prebuilt\windows-x86\csgo_gc.dll",
    "vendor\csgo-gc\prebuilt\windows-x86\PROVENANCE.md",
    "scripts\install-b2g-server-gc.ps1",
    "scripts\install-game-toolchain.ps1",
    "scripts\provision-game-server.mjs",
    "scripts\start-srcds-hidden.ps1"
)
foreach ($relative in $requiredReleaseFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $relative) -PathType Leaf)) {
        throw "Release is missing $relative"
    }
}
if (-not (Test-Path -LiteralPath $credentialsSource -PathType Leaf)) {
    throw "Node credential file does not exist: $credentialsSource"
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { throw "Install Node.js 22 or newer before provisioning the game node." }
$nodeVersion = (& $node --version).TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 22) { throw "Node.js 22 or newer is required." }

$releaseBase = Join-Path $root "releases"
$target = Join-Path $releaseBase $Version
$secretRoot = Join-Path $root "secrets"
$serviceRoot = Join-Path $root "service"
$stateDirectory = Join-Path $root "state"
$toolRoot = Join-Path $root "tools"
$logRoot = Join-Path $root "logs"
$credentialsDestination = Join-Path $secretRoot "node.env"
$pointer = Join-Path $stateDirectory "current-release.txt"

$settings = @{}
foreach ($line in Get-Content -LiteralPath $credentialsSource) {
    if (-not $line -or $line.TrimStart().StartsWith('#')) { continue }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { throw "Malformed node credential line." }
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1)
    if ($name -notmatch '^[A-Z][A-Z0-9_]+$') { throw "Unsafe node environment name." }
    $settings[$name] = $value
}
$requiredSettings = @(
    "AFTERTICK_API_URL",
    "AFTERTICK_NODE_TOKEN",
    "MANIFEST_SIGNING_SECRET",
    "AFTERTICK_SERVER_ROOT",
    "AFTERTICK_SRCDS_LAUNCHER",
    "AFTERTICK_SERVER_ADDRESS",
    "AFTERTICK_SRCDS_HOST",
    "AFTERTICK_SRCDS_PORT",
    "AFTERTICK_GOTV_PORT",
    "AFTERTICK_SRCDS_LAN",
    "AFTERTICK_SRCDS_GSLT",
    "AFTERTICK_SRCDS_RCON",
    "AFTERTICK_SRCDS_IDLE_PASSWORD"
)
foreach ($name in $requiredSettings) {
    if (-not $settings.ContainsKey($name) -or -not $settings[$name]) {
        throw "Required node setting is missing: $name"
    }
}
if (-not $settings.ContainsKey("AFTERTICK_LATENCY_PROBE_PORT")) {
    $settings["AFTERTICK_LATENCY_PROBE_PORT"] = "27125"
}
$expectedServerRoot = Join-Path $toolRoot "csgo-server"
$expectedLauncher = Join-Path $serviceRoot "start-srcds-hidden.ps1"
if ([IO.Path]::GetFullPath($settings["AFTERTICK_SERVER_ROOT"]) -ne $expectedServerRoot) {
    throw "AFTERTICK_SERVER_ROOT must be $expectedServerRoot"
}
if ([IO.Path]::GetFullPath($settings["AFTERTICK_SRCDS_LAUNCHER"]) -ne $expectedLauncher) {
    throw "AFTERTICK_SRCDS_LAUNCHER must be $expectedLauncher"
}
if ($settings["AFTERTICK_SRCDS_LAN"] -ne "0" -or $settings["AFTERTICK_SRCDS_HOST"] -ne "0.0.0.0") {
    throw "A hosted node must explicitly use AFTERTICK_SRCDS_LAN=0 and AFTERTICK_SRCDS_HOST=0.0.0.0."
}
if ($settings["AFTERTICK_SRCDS_GSLT"] -notmatch '^[a-fA-F0-9]{32}$') {
    throw "AFTERTICK_SRCDS_GSLT must be a 32-character token created for Steam AppID 4465480."
}
if ($settings["AFTERTICK_NODE_TOKEN"].Length -lt 32 -or $settings["MANIFEST_SIGNING_SECRET"].Length -lt 32) {
    throw "Node and manifest credentials must contain at least 32 characters."
}
if ($settings["AFTERTICK_SRCDS_RCON"] -notmatch '^[a-zA-Z0-9_-]{12,128}$') {
    throw "AFTERTICK_SRCDS_RCON contains unsafe characters or has an invalid length."
}
if ($settings["AFTERTICK_SRCDS_IDLE_PASSWORD"] -notmatch '^[a-zA-Z0-9_-]{16,128}$') {
    throw "AFTERTICK_SRCDS_IDLE_PASSWORD contains unsafe characters or has an invalid length."
}
$apiUri = [uri]$settings["AFTERTICK_API_URL"]
if ($apiUri.Scheme -ne "https") { throw "The hosted node API URL must use HTTPS." }
foreach ($portName in @("AFTERTICK_SRCDS_PORT", "AFTERTICK_GOTV_PORT", "AFTERTICK_LATENCY_PROBE_PORT")) {
    $port = 0
    if (-not [int]::TryParse($settings[$portName], [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw "$portName must be a valid network port."
    }
}
if ($settings["AFTERTICK_SERVER_ADDRESS"] -match '^(127\.|localhost|0\.0\.0\.0)') {
    throw "AFTERTICK_SERVER_ADDRESS must be the externally routable game endpoint."
}

if ($ValidateOnly) {
    Write-Output ([ordered]@{
        version = $Version
        releaseFiles = $requiredReleaseFiles.Count
        nodeMajorVersion = [int]$nodeVersion
        publicMode = $true
        standaloneAppId = 4465480
        steamGameServerLogin = $true
        ownedInventoryGc = $true
        httpsControlPlane = $true
        secretsPresent = $true
        stateRoot = $root
    } | ConvertTo-Json)
    return
}

$principal = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run the game-node installer from an elevated PowerShell session."
}
if (Get-Process -Name srcds -ErrorAction SilentlyContinue) {
    throw 'A game server is running. Finish and drain its match before installing; no server will be stopped by this installer.'
}

foreach ($directory in @($releaseBase, $secretRoot, $serviceRoot, $stateDirectory, $toolRoot, $logRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $target)) {
    Copy-Item -LiteralPath $source -Destination $target -Recurse
}
Assert-ReleaseFiles $target
foreach ($relative in $requiredReleaseFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $target $relative) -PathType Leaf)) {
        throw "Installed release is incomplete: $relative"
    }
}

if (-not [string]::Equals(
    $credentialsSource,
    [IO.Path]::GetFullPath($credentialsDestination),
    [StringComparison]::OrdinalIgnoreCase
)) {
    Copy-Item -LiteralPath $credentialsSource -Destination $credentialsDestination -Force
}
Copy-Item `
    -LiteralPath (Join-Path $target "scripts\start-srcds-hidden.ps1") `
    -Destination (Join-Path $serviceRoot "start-srcds-hidden.ps1") `
    -Force
Copy-Item `
    -LiteralPath (Join-Path $target "deploy\hosts\windows\Start-AftertickGameNode.ps1") `
    -Destination (Join-Path $serviceRoot "Start-AftertickGameNode.ps1") `
    -Force

foreach ($name in $settings.Keys) {
    $value = $settings[$name]
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

$taskName = "Aftertick Game Node"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
if (Get-Process -Name srcds -ErrorAction SilentlyContinue) {
    throw 'A game server started during maintenance. Finish its match before retrying the installation.'
}
Start-Sleep -Seconds 2

$toolchainArguments = @{
    ToolRoot = $toolRoot
    SkipServerDownload = [bool]$SkipServerDownload
    SkipPluginBuild = $true
    PluginPath = Join-Path $target "artifacts\sourcemod\aftertick_match.smx"
    AntiCheatRoot = Join-Path $target "artifacts\sourcemod\smac"
    AntiCheatConfig = Join-Path $target "infra\game-server\cfg\smac.cfg"
}
& (Join-Path $target "scripts\install-game-toolchain.ps1") @toolchainArguments
if ($LASTEXITCODE -ne 0) { throw "Game-server toolchain provisioning failed." }

& (Join-Path $target "scripts\install-b2g-server-gc.ps1") `
    -ServerRoot $expectedServerRoot `
    -ArtifactRoot (Join-Path $target "vendor\csgo-gc\prebuilt\windows-x86") `
    -ConfigPath (Join-Path $target "infra\game-server\gc\config.txt") `
    -LicensePath (Join-Path $target "vendor\csgo-gc\LICENSE")
if ($LASTEXITCODE -ne 0) { throw "B2G local-GC provisioning failed." }

$localServiceSid = "*S-1-5-19"
$systemSid = "*S-1-5-18"
$administratorsSid = "*S-1-5-32-544"
& icacls.exe $secretRoot /inheritance:r /grant:r `
    "${systemSid}:(OI)(CI)F" `
    "${administratorsSid}:(OI)(CI)F" `
    "${localServiceSid}:(OI)(CI)R" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not protect node credentials." }
$serverSecrets = Join-Path $expectedServerRoot "csgo\cfg\aftertick-secrets.cfg"
if (-not (Test-Path -LiteralPath $serverSecrets -PathType Leaf)) {
    throw "The rendered SRCDS secret config does not exist: $serverSecrets"
}
& icacls.exe $serverSecrets /inheritance:r /grant:r `
    "${systemSid}:F" `
    "${administratorsSid}:F" `
    "${localServiceSid}:R" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not protect the rendered SRCDS credentials." }
& icacls.exe $toolRoot /grant `
    "${localServiceSid}:(OI)(CI)M" | Out-Null
& icacls.exe $logRoot /grant `
    "${localServiceSid}:(OI)(CI)M" | Out-Null
& icacls.exe $releaseBase /grant `
    "${localServiceSid}:(OI)(CI)RX" | Out-Null
& icacls.exe $serviceRoot /grant `
    "${localServiceSid}:(OI)(CI)RX" | Out-Null
& icacls.exe $stateDirectory /grant `
    "${localServiceSid}:(OI)(CI)R" | Out-Null

[IO.File]::WriteAllText($pointer, $target, [Text.UTF8Encoding]::new($false))

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$runner = Join-Path $serviceRoot "Start-AftertickGameNode.ps1"
$action = New-ScheduledTaskAction `
    -Execute $powershell `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -StateRoot `"$root`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId "NT AUTHORITY\LOCAL SERVICE" `
    -LogonType ServiceAccount `
    -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet `
    -Priority 5 `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $taskPrincipal `
    -Settings $taskSettings `
    -Force | Out-Null

if (-not $SkipFirewall) {
    $gamePort = [int]$settings["AFTERTICK_SRCDS_PORT"]
    $gotvPort = [int]$settings["AFTERTICK_GOTV_PORT"]
    $latencyProbePort = [int]$settings["AFTERTICK_LATENCY_PROBE_PORT"]
    foreach ($rule in @(
        @{ Name = "Aftertick SRCDS UDP $gamePort"; Port = $gamePort },
        @{ Name = "Aftertick GOTV UDP $gotvPort"; Port = $gotvPort },
        @{ Name = "Aftertick Latency Probe UDP $latencyProbePort"; Port = $latencyProbePort }
    )) {
        if (-not (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule `
                -DisplayName $rule.Name `
                -Group "Aftertick" `
                -Direction Inbound `
                -Action Allow `
                -Protocol UDP `
                -LocalPort $rule.Port `
                -Profile Any | Out-Null
        }
    }
}

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $taskName
if ($task.State -ne "Running") {
    $log = Join-Path $logRoot "node-agent.log"
    $tail = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 20 } else { @() }
    throw "The game-node task did not remain running. $($tail -join [Environment]::NewLine)"
}

Write-Host "Aftertick game node $Version is installed and running as LOCAL SERVICE."
Write-Host "Only UDP game/GOTV/latency-probe ports were opened; RCON TCP was not exposed."

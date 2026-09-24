$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
function Get-Sha256 {
    param([Parameter(Mandatory)] [string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".artifacts\game-node"))
$archive = Get-ChildItem -LiteralPath $artifactRoot -Filter "aftertick-game-node-*.zip" -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $archive) { throw "Build a game-node release before testing its installer." }

$testRoot = [IO.Path]::GetFullPath((Join-Path $artifactRoot ("installer-" + [guid]::NewGuid().ToString("N"))))
if (-not (($testRoot.TrimEnd('\') + '\').StartsWith(
    $artifactRoot.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
))) {
    throw "Installer test root escaped the artifact directory."
}

try {
    $release = Join-Path $testRoot "release"
    $state = Join-Path $testRoot "state-root"
    $credentials = Join-Path $testRoot "node.env"
    New-Item -ItemType Directory -Path $release,$state -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $release
    $releaseManifest = Get-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Raw | ConvertFrom-Json

    $serverRoot = Join-Path $state "tools\csgo-server"
    $launcher = Join-Path $state "service\start-srcds-hidden.ps1"
    $content = @(
        "AFTERTICK_API_URL=https://play.aftertick.example",
        "AFTERTICK_NODE_TOKEN=aftertick-fixture-node-token-at-least-32",
        "MANIFEST_SIGNING_SECRET=aftertick-fixture-manifest-secret-32",
        "AFTERTICK_SERVER_ROOT=$serverRoot",
        "AFTERTICK_SRCDS_LAUNCHER=$launcher",
        "AFTERTICK_NODE_INSTANCE_KEY=csgo-01",
        "AFTERTICK_SERVER_ADDRESS=game.aftertick.example:27115",
        "AFTERTICK_SRCDS_HOST=0.0.0.0",
        "AFTERTICK_SRCDS_PORT=27115",
        "AFTERTICK_GOTV_PORT=27120",
        "AFTERTICK_LATENCY_PROBE_PORT=27125",
        "AFTERTICK_SRCDS_LAN=0",
        "AFTERTICK_SRCDS_GSLT=0123456789abcdef0123456789abcdef",
        "AFTERTICK_SRCDS_RCON=aftertick-fixture-rcon",
        "AFTERTICK_SRCDS_IDLE_PASSWORD=aftertick-fixture-idle",
        "AFTERTICK_NODE_HEARTBEAT_MS=2000",
        "AFTERTICK_SERVER_BUILD_ID=12426148",
        "AFTERTICK_PLUGIN_VERSION=0.1.0",
        ""
    ) -join "`n"
    [IO.File]::WriteAllText($credentials, $content, [Text.UTF8Encoding]::new($false))

    $installer = Join-Path $release "deploy\hosts\windows\Install-AftertickGameNode.ps1"
    $result = & $installer `
        -Version $releaseManifest.version `
        -ReleaseRoot $release `
        -CredentialsFile $credentials `
        -StateRoot $state `
        -ValidateOnly | Out-String
    $report = $result | ConvertFrom-Json
    if (
        -not $report.publicMode `
        -or -not $report.steamGameServerLogin `
        -or $report.standaloneAppId -ne 4465480 `
        -or -not $report.ownedInventoryGc `
        -or -not $report.httpsControlPlane `
        -or $report.releaseFiles -lt 7
    ) {
        throw "Installer validation did not prove the hosted contract."
    }
    if ((Get-ChildItem -LiteralPath $state -Force).Count -ne 0) {
        throw "ValidateOnly mutated the target state root."
    }

    $validationArgs = @{
        Version = $releaseManifest.version; ReleaseRoot = $release
        CredentialsFile = $credentials; StateRoot = $state; ValidateOnly = $true
    }
    $validationArgs.Version = '999.0.0'
    $rejected = $false
    try { & $installer @validationArgs | Out-Null }
    catch { $rejected = $_.Exception.Message -match 'manifest version' }
    if (-not $rejected) { throw 'Installer accepted a mismatched release version.' }
    $validationArgs.Version = $releaseManifest.version
    $agentPath = Join-Path $release 'apps\node-agent\dist\main.js'
    $agentBytes = [IO.File]::ReadAllBytes($agentPath)
    try {
        [IO.File]::AppendAllText($agentPath, 'tampered')
        $rejected = $false
        try { & $installer @validationArgs | Out-Null }
        catch { $rejected = $_.Exception.Message -match 'checksum mismatch' }
        if (-not $rejected) { throw 'Installer accepted a modified release executable.' }
    } finally { [IO.File]::WriteAllBytes($agentPath, $agentBytes) }

    $gcFixture = Join-Path $testRoot "gc-server"
    New-Item -ItemType Directory -Path (Join-Path $gcFixture "bin") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $gcFixture "csgo_gc") -Force | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $gcFixture "srcds.exe"), [byte[]](0x4d, 0x5a, 1, 2, 3))
    [IO.File]::WriteAllBytes((Join-Path $gcFixture "bin\dedicated.dll"), [byte[]](0x4d, 0x5a, 4, 5, 6))
    $indentedConfig = ((Get-Content -LiteralPath (Join-Path $release "infra\game-server\gc\config.txt")) |
        ForEach-Object { "    $_" }) -join "`n"
    $legacyConfig = "`"config`"`n{`n${indentedConfig}`n}`n"
    [IO.File]::WriteAllText(
        (Join-Path $gcFixture "csgo_gc\config.txt"),
        $legacyConfig,
        [Text.UTF8Encoding]::new($false)
    )
    if ((Get-Sha256 (Join-Path $gcFixture "csgo_gc\config.txt")) `
        -ne "C92CD167BC7414FEE5A8ABD0E748498582C1CC1CC19B7B2AAAC2B35BE46A75B3") {
        throw "Legacy wrapped B2G config fixture changed unexpectedly."
    }
    $gcInstaller = Join-Path $release "scripts\install-b2g-server-gc.ps1"
    $gcArgs = @{
        ServerRoot = $gcFixture
        ArtifactRoot = Join-Path $release "vendor\csgo-gc\prebuilt\windows-x86"
        ConfigPath = Join-Path $release "infra\game-server\gc\config.txt"
        LicensePath = Join-Path $release "vendor\csgo-gc\LICENSE"
    }
    & $gcInstaller @gcArgs | Out-Null
    $installedTimes = @{}
    foreach ($file in Get-ChildItem -LiteralPath $gcFixture -File -Recurse) {
        $installedTimes[$file.FullName] = $file.LastWriteTimeUtc
    }
    & $gcInstaller @gcArgs | Out-Null
    foreach ($file in Get-ChildItem -LiteralPath $gcFixture -File -Recurse) {
        if ($installedTimes[$file.FullName] -ne $file.LastWriteTimeUtc) {
            throw 'Repeated GC installation rewrote a current file.'
        }
    }
    if (
        -not (Test-Path -LiteralPath (Join-Path $gcFixture "srcds.exe.b2g-original")) `
        -or (Get-Sha256 (Join-Path $gcFixture "srcds.exe")) `
            -ne (Get-Sha256 (Join-Path $gcArgs.ArtifactRoot 'srcds.exe')) `
        -or (Get-Sha256 (Join-Path $gcFixture "csgo_gc\csgo_gc.dll")) `
            -ne (Get-Sha256 (Join-Path $gcArgs.ArtifactRoot 'csgo_gc.dll')) `
        -or (Get-Content -LiteralPath (Join-Path $gcFixture "csgo_gc\config.txt") -Raw) `
            -notmatch '^"log_output"\s+"2"' `
        -or (Test-Path -LiteralPath (Join-Path $gcFixture "csgo_gc\config.txt.b2g-original"))
    ) {
        throw "Dedicated-server local-GC install was not verified or idempotent."
    }
    Write-Output "Game-node installer validation passed without host mutation."
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

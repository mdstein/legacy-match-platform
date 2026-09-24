param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Get-Sha256 {
    param([Parameter(Mandatory)] [string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

if (-not $Version) {
    $Version = (Get-Content -LiteralPath (Join-Path $workspace "packages\contracts\src\release.json") -Raw | ConvertFrom-Json).nodeVersion
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
    throw "Version must be a semantic release identifier."
}

$artifactRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".artifacts\game-node"))
$archive = Join-Path $artifactRoot "aftertick-game-node-$Version.zip"
if (Test-Path -LiteralPath $archive) {
    throw "Release $Version already exists. Choose a new version; immutable archives are never overwritten."
}
$staging = [IO.Path]::GetFullPath((Join-Path $artifactRoot "staging-$Version"))
if (-not (($staging.TrimEnd('\') + '\').StartsWith(
    $artifactRoot.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
))) {
    throw "Staging path escaped the game-node artifact root."
}
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
}
New-Item -ItemType Directory -Path $staging -Force | Out-Null

Push-Location $workspace
$previousBuildVersion = $env:B2G_NODE_BUILD_VERSION
try {
    $env:B2G_NODE_BUILD_VERSION = $Version
    npm run build --workspace @aftertick/node-agent
    if ($LASTEXITCODE -ne 0) { throw "Node-agent build failed." }
    $reportedVersion = & node apps/node-agent/dist/main.js --version
    if ($LASTEXITCODE -ne 0 -or $reportedVersion -ne "B2G Game Node $Version") {
        throw "Built node-agent does not report release $Version."
    }
    npm run game:plugin:build
    if ($LASTEXITCODE -ne 0) { throw "SourceMod plugin build failed." }
    npm run game:anticheat:build
    if ($LASTEXITCODE -ne 0) { throw "SMAC plugin build failed." }
}
finally {
    $env:B2G_NODE_BUILD_VERSION = $previousBuildVersion
    Pop-Location
}

$files = @(
    "apps\node-agent\dist\main.js",
    ".artifacts\sourcemod\aftertick_match.smx",
    ".artifacts\sourcemod\smac\plugins\smac.smx",
    ".artifacts\sourcemod\smac\plugins\smac_aimbot.smx",
    ".artifacts\sourcemod\smac\plugins\smac_autotrigger.smx",
    ".artifacts\sourcemod\smac\plugins\smac_eyetest.smx",
    ".artifacts\sourcemod\smac\plugins\smac_speedhack.smx",
    ".artifacts\sourcemod\smac\plugins\smac_spinhack.smx",
    ".artifacts\sourcemod\smac\translations\smac.phrases.txt",
    ".artifacts\sourcemod\smac\licenses\SMAC-GPL-3.0.txt",
    ".artifacts\sourcemod\smac\licenses\MultiColors-GPL-3.0.txt",
    ".artifacts\sourcemod\smac\source\smac-ea15f3ec0c8d9c499d0e42d7174675dd6d30780b.tar.gz",
    ".artifacts\sourcemod\smac\source\multicolors-d2f2dc9126255571c0fc4499d5729cacb57265ca.tar.gz",
    ".artifacts\sourcemod\smac\provenance.json",
    "deploy\hosts\windows\Install-AftertickGameNode.ps1",
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
foreach ($relative in $files) {
    $source = Join-Path $workspace $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Release input is missing: $relative" }
    $bundleRelative = if ($relative.StartsWith(".artifacts\")) {
        "artifacts\" + $relative.Substring(".artifacts\".Length)
    } else {
        $relative
    }
    $destination = Join-Path $staging $bundleRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}

[IO.File]::WriteAllText(
    (Join-Path $staging 'apps\node-agent\package.json'),
    (@{ name = '@aftertick/node-agent'; version = $Version; private = $true; type = 'module' } | ConvertTo-Json),
    [Text.UTF8Encoding]::new($false)
)

$gcInstallerPath = Join-Path $workspace "scripts\install-b2g-server-gc.ps1"
$gcInstaller = Get-Content -LiteralPath $gcInstallerPath -Raw
$managedGcArtifacts = @{
    Wrapper = Join-Path $workspace "vendor\csgo-gc\prebuilt\windows-x86\srcds.exe"
    Library = Join-Path $workspace "vendor\csgo-gc\prebuilt\windows-x86\csgo_gc.dll"
}
foreach ($artifactName in $managedGcArtifacts.Keys) {
    $pin = [regex]::Match(
        $gcInstaller,
        "(?m)^\s*$artifactName\s*=\s*`"([a-fA-F0-9]{64})`"\s*$"
    )
    if (-not $pin.Success) {
        throw "The B2G local-GC installer has no valid $artifactName SHA-256 pin."
    }
    $artifactHash = Get-Sha256 $managedGcArtifacts[$artifactName]
    if ($pin.Groups[1].Value.ToLowerInvariant() -ne $artifactHash) {
        throw "The B2G local-GC installer $artifactName pin does not match the bundled artifact."
    }
}

$manifestFiles = Get-ChildItem -LiteralPath $staging -File -Recurse | Sort-Object FullName
$manifest = [ordered]@{
    version = $Version
    createdAt = [DateTimeOffset]::UtcNow.ToString("o")
    files = @($manifestFiles | ForEach-Object {
        [ordered]@{
            path = $_.FullName.Substring($staging.Length).TrimStart('\').Replace('\', '/')
            sha256 = Get-Sha256 $_.FullName
            sizeBytes = $_.Length
        }
    })
}
$manifestPath = Join-Path $staging "release-manifest.json"
[IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 5),
    [Text.UTF8Encoding]::new($false)
)

Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $archive -CompressionLevel Optimal
$archiveHash = Get-Sha256 $archive

Write-Output ([ordered]@{
    version = $Version
    archive = $archive
    sha256 = $archiveHash
    sizeBytes = (Get-Item -LiteralPath $archive).Length
} | ConvertTo-Json)

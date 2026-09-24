param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $Version) {
    $Version = (Get-Content -LiteralPath (Join-Path $workspace "package.json") -Raw | ConvertFrom-Json).version
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
    throw "Version must be a semantic release identifier."
}

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

$artifactRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".artifacts\app-host"))
$archive = Join-Path $artifactRoot "aftertick-app-host-$Version.zip"
if (Test-Path -LiteralPath $archive) {
    throw "Release $Version already exists. Choose a new version; immutable archives are never overwritten."
}
$staging = [IO.Path]::GetFullPath((Join-Path $artifactRoot "staging-$Version"))
if (-not (($staging.TrimEnd('\') + '\').StartsWith(
    $artifactRoot.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
))) {
    throw "Staging path escaped the app-host artifact root."
}
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

Copy-Item `
    -LiteralPath (Join-Path $workspace "deploy\compose.hosted.yml") `
    -Destination (Join-Path $staging "compose.hosted.yml")
$manifest = [ordered]@{
    version = $Version
    createdAt = [DateTimeOffset]::UtcNow.ToString("o")
    format = "aftertick-app-host-v1"
}
$manifestPath = Join-Path $staging "release-manifest.json"
[IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json),
    [Text.UTF8Encoding]::new($false)
)

$checksumLines = @(
    "$(Get-Sha256 (Join-Path $staging 'compose.hosted.yml'))  compose.hosted.yml",
    "$(Get-Sha256 $manifestPath)  release-manifest.json"
)
[IO.File]::WriteAllText(
    (Join-Path $staging "SHA256SUMS"),
    (($checksumLines -join "`n") + "`n"),
    [Text.UTF8Encoding]::new($false)
)

Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $archive -CompressionLevel Optimal
Write-Output ([ordered]@{
    version = $Version
    archive = $archive
    sha256 = Get-Sha256 $archive
    files = 3
    credentialsBundled = $false
} | ConvertTo-Json)

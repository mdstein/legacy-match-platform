param(
    [string]$ArchivePath
)

$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".artifacts\app-host"))
if (-not $ArchivePath) {
    $ArchivePath = Get-ChildItem -LiteralPath $artifactRoot -Filter "aftertick-app-host-*.zip" -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ArchivePath) { throw "No app-host release archive exists." }
$archive = [IO.Path]::GetFullPath($ArchivePath)
if (-not (($archive.TrimEnd('\') + '\').StartsWith(
    $artifactRoot.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
))) {
    throw "The release archive must remain below $artifactRoot"
}

function Get-Sha256 {
    param([Parameter(Mandatory)] [string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

$verificationRoot = Join-Path $artifactRoot ("verify-" + [guid]::NewGuid().ToString("N"))
try {
    Expand-Archive -LiteralPath $archive -DestinationPath $verificationRoot
    $files = Get-ChildItem -LiteralPath $verificationRoot -File
    if ($files.Count -ne 3) { throw "App-host bundle must contain exactly three files." }
    foreach ($name in @("compose.hosted.yml", "release-manifest.json", "SHA256SUMS")) {
        if (-not (Test-Path -LiteralPath (Join-Path $verificationRoot $name) -PathType Leaf)) {
            throw "App-host bundle is missing $name"
        }
    }
    $checksums = @{}
    foreach ($line in Get-Content -LiteralPath (Join-Path $verificationRoot "SHA256SUMS")) {
        if ($line -notmatch '^([a-f0-9]{64})  ([a-zA-Z0-9._-]+)$') { throw "Unsafe checksum entry." }
        $checksums[$Matches[2]] = $Matches[1]
    }
    foreach ($name in @("compose.hosted.yml", "release-manifest.json")) {
        if ((Get-Sha256 (Join-Path $verificationRoot $name)) -ne $checksums[$name]) {
            throw "Checksum mismatch for $name"
        }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $verificationRoot "release-manifest.json") -Raw | ConvertFrom-Json
    if ($manifest.format -ne "aftertick-app-host-v1") { throw "Unsupported app-host bundle format." }
    Write-Output ([ordered]@{
        version = $manifest.version
        archive = $archive
        archiveSha256 = Get-Sha256 $archive
        verifiedFiles = 3
        credentialsBundled = $false
    } | ConvertTo-Json)
}
finally {
    if (Test-Path -LiteralPath $verificationRoot) {
        Remove-Item -LiteralPath $verificationRoot -Recurse -Force
    }
}

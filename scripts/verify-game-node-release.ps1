param(
    [string]$ArchivePath
)

$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".artifacts\game-node"))
if (-not $ArchivePath) {
    $ArchivePath = Get-ChildItem -LiteralPath $artifactRoot -Filter "aftertick-game-node-*.zip" -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ArchivePath) { throw "No game-node release archive exists." }
$archive = [IO.Path]::GetFullPath($ArchivePath)
if (-not (($archive.TrimEnd('\') + '\').StartsWith(
    $artifactRoot.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
))) {
    throw "The release archive must remain below $artifactRoot"
}
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Archive does not exist: $archive" }

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

$verificationRoot = [IO.Path]::GetFullPath((Join-Path $artifactRoot ("verify-" + [guid]::NewGuid().ToString("N"))))
if (-not (($verificationRoot.TrimEnd('\') + '\').StartsWith(
    $artifactRoot.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
))) {
    throw "Verification path escaped the artifact root."
}

try {
    Expand-Archive -LiteralPath $archive -DestinationPath $verificationRoot
    $manifestPath = Join-Path $verificationRoot "release-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Release archive has no release-manifest.json."
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.version -or -not $manifest.files) { throw "Release manifest is incomplete." }

    $expected = @{}
    foreach ($entry in $manifest.files) {
        if ($entry.path -notmatch '^[a-zA-Z0-9._/-]+$' -or $entry.path.Contains("..")) {
            throw "Unsafe manifest path: $($entry.path)"
        }
        $candidate = [IO.Path]::GetFullPath((Join-Path $verificationRoot $entry.path.Replace('/', '\')))
        if (-not (($candidate.TrimEnd('\') + '\').StartsWith(
            $verificationRoot.TrimEnd('\') + '\',
            [StringComparison]::OrdinalIgnoreCase
        ))) {
            throw "Manifest entry escaped the verification root."
        }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Manifest file is missing: $($entry.path)"
        }
        $item = Get-Item -LiteralPath $candidate
        if ($item.Length -ne [long]$entry.sizeBytes) { throw "Size mismatch: $($entry.path)" }
        if ((Get-Sha256 $candidate) -ne $entry.sha256) { throw "SHA-256 mismatch: $($entry.path)" }
        $expected[$candidate.ToLowerInvariant()] = $true
    }

    $actual = Get-ChildItem -LiteralPath $verificationRoot -File -Recurse |
        Where-Object { $_.FullName -ne $manifestPath }
    foreach ($item in $actual) {
        if (-not $expected.ContainsKey($item.FullName.ToLowerInvariant())) {
            throw "Unmanifested release file: $($item.FullName)"
        }
        if ($item.Name -match '(?i)(\.env|credential|secret|token|password)') {
            throw "Potential credential file was bundled: $($item.FullName)"
        }
    }
    if ($actual.Count -ne $expected.Count) { throw "Release file count does not match the manifest." }

    # Older immutable bundles have no version CLI. New releases must prove that
    # the packaged executable and heartbeat identify the manifest's version.
    if ([version]($manifest.version -split '-')[0] -ge [version]'0.1.21') {
        $reportedVersion = & node (Join-Path $verificationRoot 'apps\node-agent\dist\main.js') --version
        if ($LASTEXITCODE -ne 0 -or $reportedVersion -ne "B2G Game Node $($manifest.version)") {
            throw 'Packaged node version disagrees with its release manifest.'
        }
    }

    Write-Output ([ordered]@{
        version = $manifest.version
        archive = $archive
        archiveSha256 = Get-Sha256 $archive
        verifiedFiles = $expected.Count
        credentialsBundled = $false
    } | ConvertTo-Json)
}
finally {
    if (Test-Path -LiteralPath $verificationRoot) {
        Remove-Item -LiteralPath $verificationRoot -Recurse -Force
    }
}

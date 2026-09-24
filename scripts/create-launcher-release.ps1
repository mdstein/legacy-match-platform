param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][uri]$DownloadUrl,
    [Parameter(Mandatory = $true)][string]$PublisherIdentityEku
)

$ErrorActionPreference = "Stop"
if ($DownloadUrl.Scheme -ne "https") { throw "DownloadUrl must use HTTPS." }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must use major.minor.patch." }
$identityEku = $PublisherIdentityEku.Trim()
if ($identityEku -notmatch '^1\.3\.6\.1\.4\.1\.311\.97\.(?!1\.0$)[0-9]+(?:\.[0-9]+)+$') {
    throw "PublisherIdentityEku must be the profile-specific Azure Artifact Signing durable identity EKU."
}

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$cargoManifest = Get-Content -LiteralPath (Join-Path $workspace "apps\launcher\Cargo.toml") -Raw
if ($cargoManifest -notmatch '(?ms)^\[package\].*?^version\s*=\s*"(?<version>\d+\.\d+\.\d+)"') {
    throw "Could not read the launcher package version."
}
if ($Matches.version -ne $Version) {
    throw "Release version $Version does not match launcher package version $($Matches.version)."
}
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".artifacts\launcher"))
$launcher = Join-Path $artifactRoot "b2g-launcher.exe"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Signed launcher does not exist: $launcher" }

$signature = Get-AuthenticodeSignature -LiteralPath $launcher
if ($signature.Status -ne "Valid") { throw "Launcher Authenticode status is $($signature.Status)." }
$ekuExtension = $signature.SignerCertificate.Extensions |
    Where-Object { $_.Oid.Value -eq "2.5.29.37" } |
    Select-Object -First 1
$signerEkus = if ($ekuExtension) { @($ekuExtension.EnhancedKeyUsages | ForEach-Object { $_.Value }) } else { @() }
if ($identityEku -notin $signerEkus) { throw "Launcher publisher does not match PublisherIdentityEku." }

$manifest = [ordered]@{
    version = $Version
    url = $DownloadUrl.AbsoluteUri
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $launcher).Hash
    publisherIdentityEku = $identityEku
}
$manifestPath = Join-Path $artifactRoot "update-manifest.json"
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
Write-Host "Release manifest: $manifestPath"

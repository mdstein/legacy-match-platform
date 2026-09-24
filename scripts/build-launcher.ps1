param(
    [string]$PublisherIdentityEku = $env:AFTERTICK_UPDATE_PUBLISHER_IDENTITY_EKU
)

$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$manifest = Join-Path $workspace "apps\launcher\Cargo.toml"
$artifactRoot = Join-Path $workspace ".artifacts\launcher"
$output = Join-Path $artifactRoot "b2g-launcher.exe"

if ($PublisherIdentityEku) {
    $normalized = $PublisherIdentityEku.Trim()
    if ($normalized -notmatch '^1\.3\.6\.1\.4\.1\.311\.97\.(?!1\.0$)[0-9]+(?:\.[0-9]+)+$') {
        throw "PublisherIdentityEku must be the profile-specific Azure Artifact Signing durable identity EKU."
    }
    $env:AFTERTICK_UPDATE_PUBLISHER_IDENTITY_EKU = $normalized
}

New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
Push-Location $workspace
try {
    npm run build --workspace @aftertick/launcher-ui
    if ($LASTEXITCODE -ne 0) { throw "Launcher interface build failed." }
} finally {
    Pop-Location
}
cargo build --release --locked --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw "Launcher release build failed." }

Copy-Item -LiteralPath (Join-Path $workspace "apps\launcher\target\release\b2g-launcher.exe") -Destination $output -Force
Write-Host "Launcher candidate: $output"
if (-not $PublisherIdentityEku) {
    Write-Warning "This unsigned build can install per user but has no pinned update publisher and will refuse self-updates."
}

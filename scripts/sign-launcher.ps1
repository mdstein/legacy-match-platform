param(
    [Parameter(Mandatory = $true)][string]$CertificateThumbprint,
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [string]$LauncherPath
)

$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".artifacts\launcher"))
$launcher = if ($LauncherPath) { [IO.Path]::GetFullPath($LauncherPath) } else { Join-Path $artifactRoot "b2g-launcher.exe" }
if (-not (($launcher + '\').StartsWith($artifactRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) {
    throw "LauncherPath must stay inside $artifactRoot"
}
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Launcher candidate does not exist: $launcher" }

$thumbprint = ($CertificateThumbprint -replace '\s', '').ToUpperInvariant()
if ($thumbprint -notmatch '^[A-F0-9]{40}$') { throw "CertificateThumbprint must contain 40 hexadecimal characters." }

$signTool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signTool) {
    $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $signTool = Get-ChildItem -LiteralPath $kits -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signTool) { throw "signtool.exe is unavailable. Install the Windows SDK Signing Tools feature." }

& $signTool sign /sha1 $thumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 /d "B2G Launcher" $launcher
if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed." }
& $signTool verify /pa /all /v $launcher
if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed after signing." }
Write-Host "Signed and verified: $launcher"

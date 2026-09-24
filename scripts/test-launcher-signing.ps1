$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$launcher = [IO.Path]::GetFullPath((Join-Path $workspace "apps\launcher\target\release\b2g-launcher.exe"))
$signedFixture = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Build the release launcher before running the signing fixture."
}
if (-not (Test-Path -LiteralPath $signedFixture -PathType Leaf)) {
    throw "The trusted Windows Authenticode fixture is unavailable: $signedFixture"
}

$signature = Get-AuthenticodeSignature -LiteralPath $signedFixture
if ($signature.Status -ne "Valid" -or -not $signature.SignerCertificate) {
    throw "The Windows Authenticode fixture status is $($signature.Status)."
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $signedFixture).Hash
$ekuExtension = $signature.SignerCertificate.Extensions |
    Where-Object { $_.Oid.Value -eq "2.5.29.37" } |
    Select-Object -First 1
$publisherIdentity = @($ekuExtension.EnhancedKeyUsages | ForEach-Object { $_.Value }) |
    Where-Object { $_ -eq "1.3.6.1.5.5.7.3.3" } |
    Select-Object -First 1
if (-not $publisherIdentity) { throw "The Windows Authenticode fixture has no code-signing EKU." }

# A GUI-subsystem executable returns immediately when invoked without a pipeline.
# Drain stdout so PowerShell waits and LASTEXITCODE belongs to this invocation.
& $launcher verify-update --file $signedFixture --sha256 $hash --publisher-identity-eku $publisherIdentity | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "The launcher rejected a valid hash-checked, identity-pinned Authenticode fixture."
}

$wrongPublisherIdentity = "1.3.6.1.5.5.7.3.4"
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $launcher verify-update --file $signedFixture --sha256 $hash --publisher-identity-eku $wrongPublisherIdentity 2>$null | Out-Null
$wrongPublisherExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorAction
if ($wrongPublisherExitCode -eq 0) {
    throw "The launcher accepted a fixture signed by an unexpected publisher."
}

Write-Host "Launcher accepted a valid Windows Authenticode chain and rejected the wrong publisher identity."
exit 0

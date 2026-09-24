param(
    [Parameter(Mandatory = $true)][string]$File
)

$ErrorActionPreference = "Stop"
$path = [IO.Path]::GetFullPath($File)
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Signed file does not exist: $path"
}

$signature = Get-AuthenticodeSignature -LiteralPath $path
if ($signature.Status -ne "Valid" -or -not $signature.SignerCertificate) {
    throw "Authenticode status is $($signature.Status)."
}

$ekuExtension = $signature.SignerCertificate.Extensions |
    Where-Object { $_.Oid.Value -eq "2.5.29.37" } |
    Select-Object -First 1
$identityEkus = if ($ekuExtension) {
    @($ekuExtension.EnhancedKeyUsages |
        ForEach-Object { $_.Value } |
        Where-Object {
            $_ -match '^1\.3\.6\.1\.4\.1\.311\.97\.' -and
            $_ -ne '1.3.6.1.4.1.311.97.1.0'
        })
} else {
    @()
}

if ($identityEkus.Count -ne 1) {
    throw "Expected exactly one profile-specific Azure Artifact Signing durable identity EKU; found $($identityEkus.Count)."
}

Write-Output $identityEkus[0]

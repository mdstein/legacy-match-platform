param(
    [Parameter(Mandatory)] [string]$ServerRoot,
    [Parameter(Mandatory)] [string]$ArtifactRoot,
    [Parameter(Mandatory)] [string]$ConfigPath,
    [Parameter(Mandatory)] [string]$LicensePath
)

$ErrorActionPreference = "Stop"
$server = [IO.Path]::GetFullPath($ServerRoot).TrimEnd('\')
$artifacts = [IO.Path]::GetFullPath($ArtifactRoot).TrimEnd('\')
if ([IO.Path]::GetPathRoot($server).TrimEnd('\') -eq $server) {
    throw "ServerRoot cannot be a drive root."
}

$expected = @{
    Wrapper = "AF53AEE4CD14667B2ECAD6DC25A2E1D9A6A4D38222B2DEE961B13BA0A8541764"
    Library = "D6FCCB8AA127022BDB6A5EECDD80E33AB4E872EDE9AFC25BA7BC73A442A2A22A"
}
function Get-B2GSha256 {
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
$wrapperSource = Join-Path $artifacts "srcds.exe"
$librarySource = Join-Path $artifacts "csgo_gc.dll"
$licenseSource = [IO.Path]::GetFullPath($LicensePath)
$provenanceSource = Join-Path $artifacts "PROVENANCE.md"
$configSource = [IO.Path]::GetFullPath($ConfigPath)
foreach ($path in @($wrapperSource, $librarySource, $licenseSource, $provenanceSource, $configSource)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "B2G local-GC release input is missing: $path"
    }
}
if ((Get-B2GSha256 $wrapperSource) -ne $expected.Wrapper) {
    throw "Pinned B2G SRCDS wrapper hash does not match."
}
if ((Get-B2GSha256 $librarySource) -ne $expected.Library) {
    throw "Pinned B2G local-GC library hash does not match."
}
if (-not (Test-Path -LiteralPath (Join-Path $server "bin\dedicated.dll") -PathType Leaf)) {
    throw "The final legacy dedicated.dll is missing from the game server."
}

function Install-ManagedFile {
    param(
        [Parameter(Mandatory)] [string]$Source,
        [Parameter(Mandatory)] [string]$Target,
        [string]$Backup,
        [string[]]$KnownManagedHashes = @()
    )

    $sourceHash = Get-B2GSha256 $Source
    $targetExists = Test-Path -LiteralPath $Target -PathType Leaf
    $targetHash = if ($targetExists) { Get-B2GSha256 $Target } else { $null }
    if ($targetHash -eq $sourceHash) {
        return
    }
    $knownManaged = $targetHash -and $KnownManagedHashes.Contains($targetHash)
    if ($targetExists -and -not $knownManaged -and $Backup -and
        -not (Test-Path -LiteralPath $Backup)) {
        Copy-Item -LiteralPath $Target -Destination $Backup
        if ((Get-B2GSha256 $Target) -ne (Get-B2GSha256 $Backup)) {
            throw "Backup verification failed for $Target"
        }
    }
    $parent = Split-Path -Parent $Target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $staged = Join-Path $parent (".b2g-" + [guid]::NewGuid().ToString("N") + ".tmp")
    Copy-Item -LiteralPath $Source -Destination $staged
    Move-Item -LiteralPath $staged -Destination $Target -Force
    if ((Get-B2GSha256 $Target) -ne $sourceHash) {
        throw "Installed B2G file failed verification: $Target"
    }
}

$gcRoot = Join-Path $server "csgo_gc"
New-Item -ItemType Directory -Path $gcRoot -Force | Out-Null
Install-ManagedFile `
    -Source $librarySource `
    -Target (Join-Path $gcRoot "csgo_gc.dll") `
    -Backup (Join-Path $gcRoot "csgo_gc.dll.b2g-original")
Install-ManagedFile `
    -Source $configSource `
    -Target (Join-Path $gcRoot "config.txt") `
    -Backup (Join-Path $gcRoot "config.txt.b2g-original") `
    -KnownManagedHashes @("c92cd167bc7414fee5a8abd0e748498582c1cc1cc19b7b2aaac2b35be46a75b3")
Install-ManagedFile -Source $licenseSource -Target (Join-Path $gcRoot "LICENSE.csgo-gc")
Install-ManagedFile -Source $provenanceSource -Target (Join-Path $gcRoot "B2G-PROVENANCE.md")
Install-ManagedFile `
    -Source $wrapperSource `
    -Target (Join-Path $server "srcds.exe") `
    -Backup (Join-Path $server "srcds.exe.b2g-original")

Write-Host "Pinned B2G owned-only local GC is installed on the dedicated server."

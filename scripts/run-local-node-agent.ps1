param(
    [string]$CredentialsFile
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$credentialsRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".artifacts\nodes"))
if (-not $CredentialsFile) {
    $CredentialsFile = Join-Path $credentialsRoot "local.env"
}
$credentials = [IO.Path]::GetFullPath($CredentialsFile)
if (-not ($credentials.TrimEnd('\') + '\').StartsWith(
    $credentialsRoot.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
)) {
    throw "Node credentials must remain below $credentialsRoot"
}
if (-not (Test-Path -LiteralPath $credentials -PathType Leaf)) {
    throw "Node credentials do not exist: $credentials"
}

foreach ($line in Get-Content -LiteralPath $credentials) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { throw "Malformed node credential line." }
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

Push-Location $workspace
try {
    npm run start --workspace @aftertick/node-agent
    if ($LASTEXITCODE -ne 0) { throw "Node agent exited with code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

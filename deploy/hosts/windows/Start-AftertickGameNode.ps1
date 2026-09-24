param(
    [string]$StateRoot = "C:\ProgramData\Aftertick"
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
if ([IO.Path]::GetPathRoot($root).TrimEnd('\') -eq $root) {
    throw "StateRoot cannot be a drive root."
}

$releaseRoot = Join-Path $root "releases"
$pointer = Join-Path $root "state\current-release.txt"
$credentialsFile = Join-Path $root "secrets\node.env"
$logRoot = Join-Path $root "logs"

trap {
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $failure = "$(Get-Date -Format o) STARTUP FAILURE: $($_ | Out-String)"
    $failure | Add-Content -LiteralPath (Join-Path $logRoot "node-agent.log") -Encoding utf8
    exit 1
}

if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) {
    throw "The current release pointer does not exist: $pointer"
}
$release = [IO.Path]::GetFullPath((Get-Content -LiteralPath $pointer -Raw).Trim())
if (-not (($release.TrimEnd('\') + '\').StartsWith(
    $releaseRoot.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
))) {
    throw "The current release must remain below $releaseRoot"
}
$agent = Join-Path $release "apps\node-agent\dist\main.js"
if (-not (Test-Path -LiteralPath $agent -PathType Leaf)) {
    throw "The bundled node agent does not exist: $agent"
}
if (-not (Test-Path -LiteralPath $credentialsFile -PathType Leaf)) {
    throw "The protected node credentials do not exist: $credentialsFile"
}

$required = @(
    "AFTERTICK_API_URL",
    "AFTERTICK_NODE_TOKEN",
    "MANIFEST_SIGNING_SECRET",
    "AFTERTICK_SERVER_ROOT",
    "AFTERTICK_SRCDS_LAUNCHER",
    "AFTERTICK_SERVER_ADDRESS",
    "AFTERTICK_SRCDS_HOST",
    "AFTERTICK_SRCDS_PORT",
    "AFTERTICK_GOTV_PORT",
    "AFTERTICK_SRCDS_LAN",
    "AFTERTICK_SRCDS_GSLT",
    "AFTERTICK_SRCDS_RCON",
    "AFTERTICK_SRCDS_IDLE_PASSWORD"
)
$loaded = @{}
foreach ($line in Get-Content -LiteralPath $credentialsFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { throw "Malformed node credential line." }
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1)
    if ($name -notmatch '^[A-Z][A-Z0-9_]+$') { throw "Unsafe node environment name." }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
    $loaded[$name] = $value
}
foreach ($name in $required) {
    if (-not $loaded.ContainsKey($name) -or -not $loaded[$name]) {
        throw "Required node setting is missing: $name"
    }
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) {
    $node = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) "nodejs\node.exe"
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node.js 22+ is not installed." }

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$log = Join-Path $logRoot "node-agent.log"
if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 100MB) {
    Move-Item -LiteralPath $log -Destination (Join-Path $logRoot "node-agent.previous.log") -Force
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $node $agent 2>&1 | ForEach-Object {
    "$(Get-Date -Format o) $_" | Add-Content -LiteralPath $log -Encoding utf8
}
$agentExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
exit $agentExitCode

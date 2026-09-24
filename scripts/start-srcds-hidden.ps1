param(
    [Parameter(Mandatory)] [string]$Executable,
    [Parameter(Mandatory)] [string]$WorkingDirectory,
    [Parameter(Mandatory)] [string]$HostAddress,
    [Parameter(Mandatory)] [int]$GamePort,
    [ValidateSet(0, 1)] [int]$LanMode = 1,
    [ValidatePattern('^[a-fA-F0-9]{32}$')] [string]$SteamAccountToken
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath($WorkingDirectory)
$executablePath = [IO.Path]::GetFullPath($Executable)
if (-not ($executablePath.TrimEnd('\') + '\').StartsWith(
    $root.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
)) {
    throw "SRCDS executable must remain below its configured server root."
}
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "SRCDS executable does not exist: $executablePath"
}

$arguments = @(
    "-console", "-usercon", "-condebug", "-conclearlog", "-game", "csgo",
    "-ip", $HostAddress,
    "-port", [string]$GamePort,
    "-maxplayers_override", "16",
    "-tickrate", "128",
    "+sv_lan", [string]$LanMode,
    "+exec", "aftertick-server.cfg",
    "+map", "de_dust2"
)
if ($LanMode -eq 1) {
    $arguments += "-insecure"
}
if ($SteamAccountToken) {
    $arguments += "+sv_setsteamaccount", $SteamAccountToken
}
$process = Start-Process `
    -FilePath $executablePath `
    -ArgumentList $arguments `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru
# Task Scheduler defaults to BelowNormal. Also normalize the actual child so
# manual launches from an older/background task do not inherit that priority.
$process.PriorityClass = [Diagnostics.ProcessPriorityClass]::Normal
Write-Output "AFTERTICK_PID=$($process.Id)"
[Console]::Out.Flush()
$process.WaitForExit()
$process.Refresh()
exit $process.ExitCode

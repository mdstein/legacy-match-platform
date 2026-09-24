param(
    [switch]$Cleanup,
    [DateTimeOffset]$StartedAfterUtc
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expected = Join-Path $workspace '.tools\csgo-server\srcds.exe'
if ($Cleanup -and $StartedAfterUtc -eq [DateTimeOffset]::MinValue) {
    throw 'Cleanup requires the fixture start time.'
}
$stopped = 0
foreach ($fixture in @(Get-Process -Name srcds -ErrorAction SilentlyContinue)) {
    try {
        # Retain the process handle before inspecting identity, avoiding PID reuse.
        $null = $fixture.Handle
        if ($fixture.HasExited -or $fixture.Path -ne $expected) { continue }
        if (-not $Cleanup) { throw 'The workspace fixture server is already running; nothing was changed.' }
        if ($fixture.StartTime.ToUniversalTime() -lt $StartedAfterUtc.UtcDateTime) {
            throw 'Refusing to stop a server that predates this fixture run.'
        }
        $fixture.Kill()
        if (-not $fixture.WaitForExit(10000)) { throw 'Fixture server process did not exit.' }
        $stopped += 1
    } finally { $fixture.Dispose() }
}
if ($Cleanup) { Write-Output "Fixture process cleanup verified ($stopped remaining process(es) stopped)." }

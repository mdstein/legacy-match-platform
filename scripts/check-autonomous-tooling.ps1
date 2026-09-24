param(
    [switch]$Json
)

$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Resolve-Executable {
    param([string[]]$Candidates)

    foreach ($candidate in $Candidates) {
        if (-not $candidate) { continue }
        if ([IO.Path]::IsPathRooted($candidate)) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return [IO.Path]::GetFullPath($candidate)
            }
            continue
        }

        $command = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }

    return $null
}

function Invoke-Captured {
    param(
        [string]$Executable,
        [string[]]$Arguments = @()
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        try {
            $lines = @(& $Executable @Arguments 2>&1 | ForEach-Object { $_.ToString() })
            $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
            return [pscustomobject]@{
                ExitCode = $exitCode
                Output = ($lines -join [Environment]::NewLine).Trim()
            }
        }
        catch {
            return [pscustomobject]@{
                ExitCode = -1
                Output = $_.Exception.Message
            }
        }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Get-FirstLine {
    param([string]$Text)

    return @($Text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)[0]
}

$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)

$signTool = Resolve-Executable @("signtool.exe")
if (-not $signTool) {
    $windowsKits = Join-Path $programFilesX86 "Windows Kits\10\bin"
    if (Test-Path -LiteralPath $windowsKits -PathType Container) {
        $signTool = Get-ChildItem -LiteralPath $windowsKits -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
}

$definitions = @(
    @{ Name = "git"; Candidates = @("git.exe", "git"); VersionArgs = @("--version") },
    @{ Name = "gh"; Candidates = @("gh.exe", "gh"); VersionArgs = @("--version") },
    @{ Name = "node"; Candidates = @("node.exe", "node"); VersionArgs = @("--version") },
    @{ Name = "npm"; Candidates = @("npm.cmd", "npm"); VersionArgs = @("--version") },
    @{ Name = "ssh"; Candidates = @("ssh.exe", "ssh"); VersionArgs = @("-V") },
    @{ Name = "docker"; Candidates = @("docker.exe", (Join-Path $programFiles "Docker\Docker\resources\bin\docker.exe")); VersionArgs = @("version", "--format", "{{.Client.Version}}") },
    @{ Name = "go"; Candidates = @("go.exe", "go", (Join-Path $programFiles "Go\bin\go.exe")); VersionArgs = @("version") },
    @{ Name = "cargo"; Candidates = @("cargo.exe", "cargo", (Join-Path $userProfile ".cargo\bin\cargo.exe")); VersionArgs = @("--version") },
    @{ Name = "rustc"; Candidates = @("rustc.exe", "rustc", (Join-Path $userProfile ".cargo\bin\rustc.exe")); VersionArgs = @("--version") },
    @{ Name = "k6"; Candidates = @("k6.exe", "k6", (Join-Path $programFiles "k6\k6.exe")); VersionArgs = @("version") },
    @{ Name = "tofu"; Candidates = @("tofu.exe", "tofu", (Join-Path $localAppData "Microsoft\WinGet\Links\tofu.exe")); VersionArgs = @("version") },
    @{ Name = "az"; Candidates = @("az.cmd", "az", (Join-Path $programFiles "Microsoft SDKs\Azure\CLI2\wbin\az.cmd")); VersionArgs = @("--version") },
    @{ Name = "rclone"; Candidates = @("rclone.exe", "rclone", (Join-Path $localAppData "Microsoft\WinGet\Links\rclone.exe")); VersionArgs = @("version") },
    @{ Name = "cloudflared"; Candidates = @("cloudflared.exe", "cloudflared", (Join-Path $programFilesX86 "cloudflared\cloudflared.exe")); VersionArgs = @("--version") },
    @{ Name = "signtool"; Candidates = @($signTool); VersionArgs = @() },
    @{ Name = "steamcmd"; Candidates = @((Join-Path $workspace ".tools\steamcmd\steamcmd.exe")); VersionArgs = @() }
)

$tools = foreach ($definition in $definitions) {
    $path = Resolve-Executable $definition.Candidates
    $version = $null
    if ($path -and $definition.VersionArgs.Count -gt 0) {
        $versionResult = Invoke-Captured $path $definition.VersionArgs
        if ($versionResult.Output) { $version = Get-FirstLine $versionResult.Output }
    }

    [pscustomobject]@{
        Name = $definition.Name
        Installed = [bool]$path
        Version = $version
        Path = $path
    }
}

$byName = @{}
foreach ($tool in $tools) { $byName[$tool.Name] = $tool }

$dockerReady = $false
$dockerVersion = $null
if ($byName["docker"].Installed) {
    $dockerResult = Invoke-Captured $byName["docker"].Path @("version", "--format", "{{.Server.Version}}")
    $dockerReady = $dockerResult.ExitCode -eq 0
    if ($dockerReady) { $dockerVersion = Get-FirstLine $dockerResult.Output }
}

$githubAuthenticated = $false
if ($byName["gh"].Installed) {
    $githubAuthenticated = (Invoke-Captured $byName["gh"].Path @("auth", "status", "--hostname", "github.com")).ExitCode -eq 0
}

$azureAuthenticated = $false
if ($byName["az"].Installed) {
    $azureAuthenticated = (Invoke-Captured $byName["az"].Path @("account", "show", "--output", "none")).ExitCode -eq 0
}

$remoteCount = 0
if ($byName["git"].Installed) {
    $remoteResult = Invoke-Captured $byName["git"].Path @("-C", $workspace, "remote")
    if ($remoteResult.ExitCode -eq 0 -and $remoteResult.Output) {
        $remoteCount = @($remoteResult.Output -split "`r?`n" | Where-Object { $_.Trim() }).Count
    }
}

$missing = @($tools | Where-Object { -not $_.Installed } | Select-Object -ExpandProperty Name)
$report = [ordered]@{
    CheckedAt = [DateTimeOffset]::Now.ToString("o")
    Workspace = $workspace
    LocalToolchainReady = $missing.Count -eq 0
    MissingTools = $missing
    DockerDaemonReady = $dockerReady
    DockerServerVersion = $dockerVersion
    GitHubAuthenticated = $githubAuthenticated
    GitRemoteConfigured = $remoteCount -gt 0
    GitRemoteCount = $remoteCount
    AzureAuthenticated = $azureAuthenticated
    Tools = $tools
    OwnerActions = @(
        if (-not $githubAuthenticated) { "Complete an interactive GitHub CLI login for the selected repository owner." }
        if ($remoteCount -eq 0) { "Create or select the private GitHub repository and configure its remote." }
        if (-not $azureAuthenticated) { "Complete an interactive Azure login after the signing subscription is selected." }
        "Purchase/select the deployment providers, then issue project-scoped DNS, storage, VPS, registry, telemetry, and paging credentials."
        "Complete Azure Artifact Signing identity validation and create the production certificate profile."
    )
}

if ($Json) {
    $report | ConvertTo-Json -Depth 5
}
else {
    $tools | Select-Object Name, Installed, Version, Path | Format-Table -AutoSize
    Write-Output ""
    Write-Output "Local toolchain ready: $($report.LocalToolchainReady)"
    Write-Output "Docker daemon ready: $($report.DockerDaemonReady)"
    Write-Output "GitHub authenticated: $($report.GitHubAuthenticated)"
    Write-Output "Git remote configured: $($report.GitRemoteConfigured)"
    Write-Output "Azure authenticated: $($report.AzureAuthenticated)"
    Write-Output ""
    Write-Output "Owner actions:"
    foreach ($action in $report.OwnerActions) { Write-Output "- $action" }
}

if ($missing.Count -gt 0) { exit 1 }

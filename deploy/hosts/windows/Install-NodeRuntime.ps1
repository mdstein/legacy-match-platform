param(
    [int]$MajorVersion = 22
)

$ErrorActionPreference = "Stop"
$existing = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
    $installedMajor = [int]((& $existing.Source --version).TrimStart('v').Split('.')[0])
    if ($installedMajor -ge $MajorVersion) {
        Write-Host "Node.js $(& $existing.Source --version) is already installed."
        return
    }
}

$releases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
$release = $releases |
    Where-Object { $_.version -match "^v$MajorVersion\.\d+\.\d+$" -and $_.lts } |
    Select-Object -First 1
if (-not $release) { throw "No supported Node.js $MajorVersion LTS release was found." }

$version = [string]$release.version
$msiName = "node-$version-x64.msi"
$baseUri = "https://nodejs.org/dist/$version"
$staging = Join-Path $env:TEMP "aftertick-node-runtime"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$msiPath = Join-Path $staging $msiName
$checksumPath = Join-Path $staging "SHASUMS256.txt"

Invoke-WebRequest -Uri "$baseUri/$msiName" -OutFile $msiPath -UseBasicParsing
Invoke-WebRequest -Uri "$baseUri/SHASUMS256.txt" -OutFile $checksumPath -UseBasicParsing
$checksumLine = Get-Content -LiteralPath $checksumPath |
    Where-Object { $_ -match "^([a-f0-9]{64})  $([regex]::Escape($msiName))$" } |
    Select-Object -First 1
if (-not $checksumLine) { throw "The official Node.js checksum list did not contain $msiName." }
$expected = ($checksumLine -split '\s+')[0]
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $msiPath).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Node.js MSI checksum verification failed." }

$process = Start-Process -FilePath msiexec.exe -ArgumentList @(
    "/i", $msiPath, "/qn", "/norestart"
) -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Node.js MSI installation failed with exit code $($process.ExitCode)." }

$node = Join-Path $env:ProgramFiles "nodejs\node.exe"
if (-not (Test-Path -LiteralPath $node)) { throw "Node.js installation completed but node.exe was not found." }
Write-Host "Installed and verified Node.js $(& $node --version)."

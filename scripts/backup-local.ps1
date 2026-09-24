param(
    [string]$OutputRoot
)

$ErrorActionPreference = "Stop"

function Get-Sha256 {
    param([Parameter(Mandatory)] [string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $workspace ".artifacts\backups"
}
$resolvedRoot = [IO.Path]::GetFullPath($OutputRoot)
$workspacePrefix = [IO.Path]::GetFullPath($workspace).TrimEnd('\') + '\'
if (-not ($resolvedRoot.TrimEnd('\') + '\').StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Backup output must stay inside the workspace: $workspace"
}

$docker = if (Test-Path -LiteralPath "C:\Program Files\Docker\Docker\resources\bin\docker.exe") {
    "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
} else {
    "docker"
}
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$backup = Join-Path $resolvedRoot $stamp
$postgresUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "aftertick" }
$postgresDatabase = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "aftertick" }
$redisPassword = if ($env:REDIS_PASSWORD) { $env:REDIS_PASSWORD } else { "aftertick-local-redis" }
$s3Bucket = if ($env:S3_BUCKET) { $env:S3_BUCKET } else { "aftertick-demos" }
New-Item -ItemType Directory -Path $backup -Force | Out-Null

Push-Location $workspace
try {
    $postgresTemp = "/tmp/aftertick-postgres-$stamp.dump"
    & $docker compose -f compose.yml exec -T postgres pg_dump -U $postgresUser -d $postgresDatabase -Fc -f $postgresTemp
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL backup failed." }
    & $docker compose -f compose.yml cp "postgres:$postgresTemp" (Join-Path $backup "postgres.dump")
    if ($LASTEXITCODE -ne 0) { throw "Could not copy PostgreSQL backup." }

    $redisTemp = "/tmp/aftertick-redis-$stamp.rdb"
    & $docker compose -f compose.yml exec -T redis redis-cli --no-auth-warning -a $redisPassword --rdb $redisTemp
    if ($LASTEXITCODE -ne 0) { throw "Redis backup failed." }
    & $docker compose -f compose.yml cp "redis:$redisTemp" (Join-Path $backup "redis.rdb")
    if ($LASTEXITCODE -ne 0) { throw "Could not copy Redis backup." }

    $objectDirectory = Join-Path $backup "objects"
    New-Item -ItemType Directory -Path $objectDirectory -Force | Out-Null
    $objectTemp = "/tmp/aftertick-objects-$stamp"
    & $docker compose -f compose.yml exec -T minio-bootstrap mkdir -p $objectTemp
    if ($LASTEXITCODE -ne 0) { throw "Could not prepare MinIO backup directory." }
    & $docker compose -f compose.yml exec -T minio-bootstrap mc mirror --overwrite "aftertick/$s3Bucket" $objectTemp
    if ($LASTEXITCODE -ne 0) { throw "MinIO backup failed." }
    & $docker compose -f compose.yml cp "minio-bootstrap:$objectTemp/." $objectDirectory
    if ($LASTEXITCODE -ne 0) { throw "Could not copy MinIO backup." }
}
finally {
    Pop-Location
}

$backupPrefix = $backup.TrimEnd('\') + '\'
$files = Get-ChildItem -LiteralPath $backup -File -Recurse | ForEach-Object {
    [ordered]@{
        path = $_.FullName.Substring($backupPrefix.Length).Replace('\', '/')
        bytes = $_.Length
        sha256 = Get-Sha256 -Path $_.FullName
    }
}
$manifest = [ordered]@{
    version = 1
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    postgresFormat = "pg_dump-custom"
    redisFormat = "rdb"
    objectStorageFormat = "files-current-versions"
    files = @($files)
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backup "manifest.json") -Encoding UTF8
Write-Host $backup

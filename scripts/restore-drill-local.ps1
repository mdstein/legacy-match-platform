param(
    [string]$BackupDirectory
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
$backupRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".artifacts\backups"))
if (-not $BackupDirectory) {
    $completeBackup = Get-ChildItem -LiteralPath $backupRoot -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "manifest.json") } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $completeBackup) {
        throw "No complete backup with a manifest exists under $backupRoot"
    }
    $BackupDirectory = $completeBackup.FullName
}
$backup = [IO.Path]::GetFullPath($BackupDirectory)
if (-not ($backup.TrimEnd('\') + '\').StartsWith($backupRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Restore drills only accept backups under $backupRoot"
}

$manifestPath = Join-Path $backup "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
    $path = Join-Path $backup ($file.path.Replace('/', '\'))
    $actual = Get-Sha256 -Path $path
    if ($actual -ne $file.sha256) {
        throw "Backup checksum mismatch: $($file.path)"
    }
}

$docker = if (Test-Path -LiteralPath "C:\Program Files\Docker\Docker\resources\bin\docker.exe") {
    "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
} else {
    "docker"
}
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss")
$restoreDatabase = "aftertick_restore_$stamp"
$restoreBucket = "aftertick-restore-$stamp"
$postgresTemp = "/tmp/$restoreDatabase.dump"
$objectTemp = "/tmp/$restoreBucket"
$postgresUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "aftertick" }

Push-Location $workspace
try {
    & $docker compose -f compose.yml cp (Join-Path $backup "postgres.dump") "postgres:$postgresTemp"
    if ($LASTEXITCODE -ne 0) { throw "Could not stage PostgreSQL backup." }
    & $docker compose -f compose.yml exec -T postgres createdb -U $postgresUser $restoreDatabase
    if ($LASTEXITCODE -ne 0) { throw "Could not create restore-drill database." }
    try {
        & $docker compose -f compose.yml exec -T postgres pg_restore -U $postgresUser -d $restoreDatabase $postgresTemp
        if ($LASTEXITCODE -ne 0) { throw "PostgreSQL restore failed." }
        $tableCount = & $docker compose -f compose.yml exec -T postgres psql -U $postgresUser -d $restoreDatabase -At -c "select count(*) from information_schema.tables where table_schema='public'"
        if ($LASTEXITCODE -ne 0 -or [int]$tableCount -lt 10) { throw "Restored PostgreSQL schema is incomplete." }
    }
    finally {
        & $docker compose -f compose.yml exec -T postgres dropdb -U $postgresUser --if-exists $restoreDatabase | Out-Null
    }

    $redisContainer = "aftertick-redis-restore-$stamp"
    & $docker create --name $redisContainer redis@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf redis-server --dir /data --dbfilename dump.rdb --appendonly no --port 6380 --requirepass restore-drill | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not create disposable Redis restore container." }
    try {
        & $docker cp (Join-Path $backup "redis.rdb") "${redisContainer}:/data/dump.rdb"
        if ($LASTEXITCODE -ne 0) { throw "Could not stage the Redis RDB." }
        & $docker start $redisContainer | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not start disposable Redis restore container." }
        & $docker exec $redisContainer redis-check-rdb /data/dump.rdb | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Redis RDB validation failed." }
        $pong = & $docker exec $redisContainer redis-cli -p 6380 -a restore-drill --no-auth-warning ping
        if ($LASTEXITCODE -ne 0 -or $pong -ne "PONG") { throw "Restored Redis did not answer PING." }
    }
    finally {
        & $docker rm --force $redisContainer | Out-Null
    }

    & $docker compose -f compose.yml exec -T minio-bootstrap mc mb "aftertick/$restoreBucket"
    if ($LASTEXITCODE -ne 0) { throw "Could not create restore-drill bucket." }
    try {
        & $docker compose -f compose.yml exec -T minio-bootstrap mkdir -p $objectTemp
        & $docker compose -f compose.yml cp ((Join-Path $backup "objects") + "\.") "minio-bootstrap:$objectTemp"
        if ($LASTEXITCODE -ne 0) { throw "Could not stage object backup." }
        & $docker compose -f compose.yml exec -T minio-bootstrap mc mirror --overwrite $objectTemp "aftertick/$restoreBucket"
        if ($LASTEXITCODE -ne 0) { throw "MinIO restore failed." }
        & $docker compose -f compose.yml exec -T minio-bootstrap mc stat "aftertick/$restoreBucket" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Restored MinIO bucket is unreadable." }
    }
    finally {
        & $docker compose -f compose.yml exec -T minio-bootstrap mc rb --force "aftertick/$restoreBucket" | Out-Null
    }
}
finally {
    Pop-Location
}

Write-Host "Restore drill passed: PostgreSQL temporary database, Redis disposable instance, and MinIO temporary bucket."

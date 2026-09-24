param(
    [switch]$SkipServerDownload,
    [string]$ToolRoot,
    [switch]$SkipPluginBuild,
    [string]$PluginPath,
    [string]$AntiCheatRoot,
    [string]$AntiCheatConfig
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$tools = if ($ToolRoot) { [IO.Path]::GetFullPath($ToolRoot) } else { Join-Path $workspace ".tools" }
$steamCmd = Join-Path $tools "steamcmd"
$server = Join-Path $tools "csgo-server"
$pluginTools = Join-Path $tools "plugin-toolchain"

$sourceModName = "sourcemod-1.12.0-git7251-windows.zip"
$sourceModHash = "A6F641683EF63FBAC7525A50F81A122405B8392B449AB402BE8DF76AEF409D06"
$metaModName = "mmsource-1.12.0-git1225-windows.zip"
$metaModHash = "568AD163A8BD48D9451193FB87AAE4C790870BC1102F427E693635F5BEA2C1A4"
$noLobbyRevision = "fb575d575d88a0b3d70acc619f8d4d3223e12814"
$noLobbySourceHash = "0416AF123A736D835FD405B1780A59D98FE984B8B2FC3293A134AC5AAC03DF76"
$noLobbyGameDataHash = "532F46E195BD9D921EC992248AEDF7E9932804FC1321F8578C46E4AAA981FBE5"
$steamFixRevision = "14e4d6b5e5b8c2f36446942daaf87b1beb8067b3"
$steamFixExtensionHash = "17C5D14AE141D20B25B8931983F98647BAE6CCDF527698101C3E217B0EF071D2"
$emptyFileHash = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"

function Get-PinnedArchive {
    param(
        [Parameter(Mandatory)] [string]$Uri,
        [Parameter(Mandatory)] [string]$Destination,
        [Parameter(Mandatory)] [string]$ExpectedHash
    )

    if (Test-Path -LiteralPath $Destination) {
        $existingHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
        if ($existingHash -eq $ExpectedHash) {
            return
        }
    }

    $download = "$Destination.download"
    Invoke-WebRequest -Uri $Uri -OutFile $download -UseBasicParsing
    $actualHash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
    if ($actualHash -ne $ExpectedHash) {
        throw "Checksum mismatch for $Uri. Expected $ExpectedHash, received $actualHash."
    }
    Move-Item -LiteralPath $download -Destination $Destination -Force
}

New-Item -ItemType Directory -Path $steamCmd,$pluginTools -Force | Out-Null

$steamCmdExe = Join-Path $steamCmd "steamcmd.exe"
if (-not (Test-Path -LiteralPath $steamCmdExe)) {
    $steamArchive = Join-Path $steamCmd "steamcmd.zip"
    Invoke-WebRequest -Uri "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip" -OutFile $steamArchive -UseBasicParsing
    Expand-Archive -LiteralPath $steamArchive -DestinationPath $steamCmd -Force
}

if (-not $SkipServerDownload) {
    & $steamCmdExe +force_install_dir $server +login anonymous +app_update 740 validate +quit
    if ($LASTEXITCODE -ne 0) {
        throw "SteamCMD failed to install or validate dedicated-server AppID 740."
    }
}

$sourceModArchive = Join-Path $pluginTools $sourceModName
$metaModArchive = Join-Path $pluginTools $metaModName
Get-PinnedArchive `
    -Uri "https://sm.alliedmods.net/smdrop/1.12/$sourceModName" `
    -Destination $sourceModArchive `
    -ExpectedHash $sourceModHash
Get-PinnedArchive `
    -Uri "https://mms.alliedmods.net/mmsdrop/1.12/$metaModName" `
    -Destination $metaModArchive `
    -ExpectedHash $metaModHash

Expand-Archive -LiteralPath $sourceModArchive -DestinationPath (Join-Path $pluginTools "sourcemod") -Force
Expand-Archive -LiteralPath $metaModArchive -DestinationPath (Join-Path $pluginTools "metamod") -Force

# App 4465480's client still uses the final Source 1 server payload from SteamCMD
# App 740, but direct connections require the engine's lobby-reservation checks
# to be bypassed. Fetch and compile the final-build-compatible patch from an
# immutable upstream revision so every node receives identical bytes.
$noLobbyRoot = Join-Path $pluginTools "nolobbyreservation"
New-Item -ItemType Directory -Path $noLobbyRoot -Force | Out-Null
$noLobbySource = Join-Path $noLobbyRoot "nolobbyreservation.sp"
$noLobbyGameData = Join-Path $noLobbyRoot "nolobbyreservation.games.txt"
$noLobbyPlugin = Join-Path $noLobbyRoot "nolobbyreservation.smx"
Get-PinnedArchive `
    -Uri "https://raw.githubusercontent.com/nuxencs/NoLobbyReservation/$noLobbyRevision/addons/sourcemod/scripting/nolobbyreservation.sp" `
    -Destination $noLobbySource `
    -ExpectedHash $noLobbySourceHash
Get-PinnedArchive `
    -Uri "https://raw.githubusercontent.com/nuxencs/NoLobbyReservation/$noLobbyRevision/addons/sourcemod/gamedata/nolobbyreservation.games.txt" `
    -Destination $noLobbyGameData `
    -ExpectedHash $noLobbyGameDataHash
$sourceModScripting = Join-Path $pluginTools "sourcemod\addons\sourcemod\scripting"
$sourcePawnCompiler = Join-Path $sourceModScripting "spcomp.exe"
& $sourcePawnCompiler `
    $noLobbySource `
    "-i$(Join-Path $sourceModScripting 'include')" `
    "-o$noLobbyPlugin"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $noLobbyPlugin -PathType Leaf)) {
    throw "NoLobbyReservation failed to compile from pinned upstream source."
}

# The archived App 4465480 client presents the engine's new Steam ticket case,
# which the final App 740 server build otherwise routes to its wrong-game
# rejection path. This pinned SourceMod extension patches only that dispatch
# entry and restores it on unload. The upstream Windows artifact is unsigned,
# so its immutable revision and SHA-256 are both enforced before installation.
$steamFixRoot = Join-Path $pluginTools "csgo-steamfix"
New-Item -ItemType Directory -Path $steamFixRoot -Force | Out-Null
$steamFixExtension = Join-Path $steamFixRoot "csgo_steamfix.ext.dll"
$steamFixAutoload = Join-Path $steamFixRoot "csgo_steamfix.autoload"
Get-PinnedArchive `
    -Uri "https://raw.githubusercontent.com/eonexdev/csgo-sv-fix-engine/$steamFixRevision/csgo_steamfix.ext.dll" `
    -Destination $steamFixExtension `
    -ExpectedHash $steamFixExtensionHash
Get-PinnedArchive `
    -Uri "https://raw.githubusercontent.com/eonexdev/csgo-sv-fix-engine/$steamFixRevision/csgo_steamfix.autoload" `
    -Destination $steamFixAutoload `
    -ExpectedHash $emptyFileHash

Push-Location $workspace
try {
    $plugin = if ($PluginPath) {
        [IO.Path]::GetFullPath($PluginPath)
    } else {
        Join-Path $workspace ".artifacts\sourcemod\aftertick_match.smx"
    }
    if (-not $SkipPluginBuild) {
        npm run game:plugin:build
        if ($LASTEXITCODE -ne 0) { throw "SourceMod plugin build failed." }
        npm run game:anticheat:build
        if ($LASTEXITCODE -ne 0) { throw "SMAC plugin build failed." }
    }
    if (-not (Test-Path -LiteralPath $plugin -PathType Leaf)) {
        throw "Compiled SourceMod plugin does not exist: $plugin"
    }
    $smacRoot = if ($AntiCheatRoot) {
        [IO.Path]::GetFullPath($AntiCheatRoot)
    } else {
        Join-Path $workspace ".artifacts\sourcemod\smac"
    }
    $smacConfig = if ($AntiCheatConfig) {
        [IO.Path]::GetFullPath($AntiCheatConfig)
    } else {
        Join-Path $workspace "infra\game-server\cfg\smac.cfg"
    }
    $serverExecutable = Join-Path $server "srcds.exe"
    if (Test-Path -LiteralPath $serverExecutable -PathType Leaf) {
        & node `
            (Join-Path $workspace "scripts\provision-game-server.mjs") `
            --server-root $server `
            --metamod-root (Join-Path $pluginTools "metamod") `
            --sourcemod-root (Join-Path $pluginTools "sourcemod") `
            --plugin $plugin `
            --config (Join-Path $workspace "infra\game-server\cfg\server.cfg") `
            --smac-root $smacRoot `
            --smac-config $smacConfig `
            --lobby-plugin $noLobbyPlugin `
            --lobby-gamedata $noLobbyGameData `
            --steamfix-extension $steamFixExtension `
            --steamfix-autoload $steamFixAutoload
        if ($LASTEXITCODE -ne 0) { throw "Game-server provisioning failed." }
    } elseif (-not $SkipServerDownload) {
        throw "SteamCMD completed without installing the SRCDS executable."
    }
}
finally {
    Pop-Location
}

if (Test-Path -LiteralPath (Join-Path $server "srcds.exe") -PathType Leaf) {
    Write-Host "Standalone CS:GO server, archived-client Steam ticket compatibility, direct-connect patch, and pinned SourceMod/MetaMod toolchain are provisioned."
} else {
    Write-Host "Pinned SourceMod/MetaMod, archived-client Steam ticket compatibility, and direct-connect build toolchain are provisioned; server download was skipped."
}

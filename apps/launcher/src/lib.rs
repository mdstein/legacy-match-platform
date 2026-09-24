use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use ureq::Agent;
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
use url::Url;

mod launcher_bridge;
pub use launcher_bridge::{
    BridgeEvent, BridgeState, CaseOpenCompletion, CaseOpenRequest, InventoryAcknowledgement,
    ItemRenameRequest, LauncherBridgeServer, LoadoutSync, PlayerProfilePresentation,
    PlayerProfilesRequest, QueueIntent, QueueMode, ReadyCheckPresentation, SprayRequest,
    SprayUnsealCompletion, TradeUpCompletion, TradeUpRequest,
    ServiceMedalRequest, ServiceMedalCompletion,
};
#[cfg(windows)]
mod client_session;
#[cfg(windows)]
pub use client_session::run_client_session;
#[cfg(not(windows))]
pub fn run_client_session() -> Result<String, String> {
    Err("The launcher-first CS:GO session is only supported on Windows.".to_string())
}
#[cfg(test)]
mod launcher_ui;
#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod webview_runtime;
mod setup;
mod uninstall;
mod trading;
mod console;
pub use console::initialize_console;
#[cfg(windows)]
pub use console::run_debug_console;
#[cfg(windows)]
pub use desktop::run_launcher_ui;
#[cfg(not(windows))]
pub fn run_launcher_ui() -> Result<(), String> {
    Err("The B2G interface is supported on Windows.".into())
}

pub const DEFAULT_API_ORIGIN: &str = "https://play.back2go.net";
const STANDALONE_APP_ID: &str = "4465480";
const LEGACY_BETA_APP_ID: &str = "730";
#[cfg(windows)]
const SOURCE_WINDOW_WAIT: Duration = Duration::from_secs(120);
#[cfg(windows)]
const SOURCE_PROCESS_WAIT: Duration = Duration::from_secs(15);
#[cfg(windows)]
const SOURCE_COLD_START_SETTLE: Duration = Duration::from_secs(12);
#[cfg(windows)]
const GC_INVENTORY_WAIT: Duration = Duration::from_secs(45);
#[cfg(windows)]
const SOURCE_COMMAND_TIMEOUT_MS: u32 = 5_000;
const HTTPS_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_API_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_INVENTORY_BUNDLE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_UPDATE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_LAUNCHER_LOG_BYTES: u64 = 1024 * 1024;
const UPDATE_PUBLISHER_IDENTITY_EKU: Option<&str> =
    option_env!("AFTERTICK_UPDATE_PUBLISHER_IDENTITY_EKU");
const ARTIFACT_SIGNING_EKU_PREFIX: &str = "1.3.6.1.4.1.311.97.";
const ARTIFACT_SIGNING_PUBLIC_TRUST_EKU: &str = "1.3.6.1.4.1.311.97.1.0";
const GC_CLIENT_WRAPPER: &[u8] =
    include_bytes!("../../../vendor/csgo-gc/prebuilt/windows-x86/csgo.exe");
const GC_LIBRARY: &[u8] =
    include_bytes!("../../../vendor/csgo-gc/prebuilt/windows-x86/csgo_gc.dll");
const GC_LICENSE: &[u8] = include_bytes!("../../../vendor/csgo-gc/LICENSE");
const GC_PROVENANCE: &[u8] =
    include_bytes!("../../../vendor/csgo-gc/prebuilt/windows-x86/PROVENANCE.md");
const GC_CLIENT_WRAPPER_SHA256: &str =
    "65bf01f46fd9bd923bbd2cbd30eea004c3e1a00a3075fafcea87c63805dea148";
const GC_LIBRARY_SHA256: &str = "210895abd0cf57e8cc6d4c3b090e30cc4243162df8f081867c5037cd5ca1635f";
// Exact embedded DLL hashes from launcher releases 0.2.22 through 0.2.34.
// Unknown pre-existing files remain recoverable originals, never cleanup targets.
const GC_LIBRARY_PREVIOUS_SHA256: &[&str] = &[
    "bcd9ae594d564c08d1e8de3b48e1d357412c1e4d36f2cf98d88b7e2b0a2637aa",
    "e67e9a50354edc6da7ce45bb6ba14f01b278df7d448e9be60d9bdd23dbd3a56f",
    "c96fbba937fe47d76e5ad9584937d42aed7d74731885bed785e8bfb9b7c2c677",
    "4402b8646294b8c70ce24df028e7fd8b98bc78229891dfd739342d46039b63da",
    "7df17e7b7bd426f627a4b41aedb1f5576ed4c154580ace882b277568185a46b8",
    "9fab2c34aa26f39dcd56e9418842b98feab0b3e0bbf320efc6e151315c0c19e4",
    "d6fccb8aa127022bdb6a5eecdd80e33ab4e872ede9afc25ba7bc73a442a2a22a",
];
const GC_CONFIG_WRAPPED_V1_SHA256: &str =
    "c92cd167bc7414fee5a8abd0e748498582c1cc1cc19b7b2aaac2b35be46a75b3";
const GC_CONFIG: &str = r#""log_output" "2"
"appid_override" "4465480"
"show_csgo_gc_servers_only" "1"
"b2g_owned_only" "1"
"rcon"
{
    "enabled" "0"
    "bind_address" "127.0.0.1"
    "port" "37016"
    "password" ""
}
"ranks"
{
    "competitive_rank" "0"
    "competitive_wins" "0"
    "wingman_rank" "0"
    "wingman_wins" "0"
    "dangerzone_rank" "0"
    "dangerzone_wins" "0"
}
"vac_banned" "0"
"cmd_friendly" "0"
"cmd_teaching" "0"
"cmd_leader" "0"
"player_level" "0"
"player_cur_xp" "0"
"#;

fn now_unix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

pub fn launcher_log_path() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("B2G").join("logs").join("launcher.log"))
}

/// The profile picture shown on the Play card. The artwork ships with the
/// launcher, so the choice is a preference of this installation rather than
/// account identity, and it is stored beside the launcher's own local data.
pub const PROFILE_ICONS: [&str; 5] = [
    "portrait",
    "rank",
    "monogram-blue",
    "monogram-green",
    "monogram-gold",
];

pub fn profile_icon_label(value: &str) -> &'static str {
    match value {
        "rank" => "Rank emblem",
        "monogram-blue" => "Monogram - blue",
        "monogram-green" => "Monogram - green",
        "monogram-gold" => "Monogram - gold",
        _ => "Portrait",
    }
}

fn profile_icon_path() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("B2G").join("launcher.json"))
}

/// The stored choice, if the file holds one this build still offers. An unknown
/// or malformed value falls back to the shipped default rather than failing.
fn stored_profile_icon(text: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get("profileIcon")?
        .as_str()
        .filter(|value| PROFILE_ICONS.contains(value))
        .map(str::to_string)
}

fn profile_icon_cache() -> &'static std::sync::Mutex<Option<String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<String>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// The stored choice, or the shipped default. Read once per process; painting
/// runs on every frame and must never touch the disk.
pub fn profile_icon() -> String {
    let Ok(mut cache) = profile_icon_cache().lock() else {
        return PROFILE_ICONS[0].to_string();
    };
    if let Some(value) = cache.as_ref() {
        return value.clone();
    }
    let stored = profile_icon_path()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| stored_profile_icon(&text))
        .unwrap_or_else(|| PROFILE_ICONS[0].to_string());
    *cache = Some(stored.clone());
    stored
}

pub fn set_profile_icon(value: &str) -> Result<(), String> {
    if !PROFILE_ICONS.contains(&value) {
        return Err("That profile picture is not available.".to_string());
    }
    if let Ok(mut cache) = profile_icon_cache().lock() {
        *cache = Some(value.to_string());
    }
    let path = profile_icon_path().ok_or("LOCALAPPDATA is unavailable.")?;
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Could not create the launcher folder: {error}"))?;
    }
    // Preserve any other launcher preference already stored alongside this one.
    let mut stored = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    stored["profileIcon"] = serde_json::Value::String(value.to_string());
    fs::write(&path, stored.to_string())
        .map_err(|error| format!("Could not save the profile picture: {error}"))
}

fn single_line_log_message(message: &str) -> String {
    message
        .chars()
        .map(|character| {
            if character == '\r' || character == '\n' || character == '\t' {
                ' '
            } else if character.is_control() {
                '?'
            } else {
                character
            }
        })
        .take(4_096)
        .collect()
}

pub fn log_launcher_event(message: &str) {
    let message = single_line_log_message(message);
    // Console output is optional. Closing a diagnostic window or a broken
    // redirected pipe must never panic in a running client session.
    let _ = writeln!(std::io::stdout(), "[B2G] {message}");
    let _ = std::io::stdout().flush();
    let Some(path) = launcher_log_path() else {
        return;
    };
    let Some(directory) = path.parent() else {
        return;
    };
    if fs::create_dir_all(directory).is_err() {
        return;
    }
    if path
        .metadata()
        .is_ok_and(|metadata| metadata.len() >= MAX_LAUNCHER_LOG_BYTES)
    {
        let previous = directory.join("launcher.previous.log");
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(&path, previous);
    }
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "[{timestamp_ms}] pid={} {}",
            std::process::id(),
            message
        );
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub launcher_version: String,
    pub steam_executable: Option<String>,
    pub steam_root: Option<String>,
    pub app_id: Option<String>,
    pub install_kind: Option<String>,
    pub app_manifest: Option<String>,
    pub app_installed: bool,
    pub game_root: Option<String>,
    pub beta_key: Option<String>,
    pub legacy_binary: Option<String>,
    pub legacy_ready: bool,
    pub inventory_access_ready: bool,
    pub inventory_client_version: Option<String>,
    pub current_client_version: Option<String>,
    pub update_publisher_pinned: bool,
    pub blocking_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameDiagnosticsReport {
    pub game_root: String,
    pub gc_wrapper_installed: bool,
    pub gc_library_installed: bool,
    pub original_launcher_backup: bool,
    pub console_log: String,
    pub gc_log: String,
    pub inventory_manifest: String,
    pub launcher_log: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectRequest {
    pub server: String,
    pub password: String,
    pub inventory_url: Option<String>,
    pub inventory_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedSticker {
    slot: u32,
    sticker_id: u32,
    wear: Option<f64>,
    scale: Option<f64>,
    rotation: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedItem {
    asset_id: String,
    #[serde(default)]
    ownership_generation: Option<String>,
    #[serde(default = "default_owned_source")]
    source: String,
    #[serde(default = "default_owned_item_kind")]
    item_kind: String,
    definition_index: u32,
    weapon_key: String,
    inventory_position: u32,
    paint_index: Option<u32>,
    paint_wear: Option<f64>,
    paint_seed: Option<u32>,
    quality: u32,
    rarity: u32,
    origin: u32,
    kill_eater_score_type: Option<u32>,
    kill_eater_value: Option<u32>,
    custom_name: Option<String>,
    #[serde(default)]
    spray_kit_id: Option<u32>,
    #[serde(default)]
    spray_tint_id: Option<u32>,
    #[serde(default)]
    sprays_remaining: Option<u32>,
    stickers: Vec<OwnedSticker>,
    loadout_slot: u32,
    equipped: bool,
}

fn default_owned_source() -> String {
    "steam".to_string()
}

fn default_owned_item_kind() -> String {
    "cosmetic".to_string()
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedPlayer {
    player_id: String,
    steam_id: String,
    items: Vec<OwnedItem>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedInventoryBundle {
    version: u8,
    #[serde(default)]
    inventory_version: Option<u64>,
    match_id: String,
    expires_at: String,
    schema_sha256: String,
    players: Vec<OwnedPlayer>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LatencyReport {
    pub server: String,
    pub requested_samples: u8,
    pub successful_samples: u8,
    pub median_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub packet_loss_percent: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LatencyProbeEndpoint {
    region: String,
    server: String,
    samples: u8,
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LatencyProbeMeasurement {
    region: String,
    server: String,
    requested_samples: u8,
    successful_samples: u8,
    median_ms: Option<f64>,
    p95_ms: Option<f64>,
    packet_loss_percent: f64,
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LatencyProbeSubmission {
    version: u8,
    challenge_id: String,
    measurements: Vec<LatencyProbeMeasurement>,
}

struct LatencyProbeRequest {
    challenge_id: String,
    token: String,
    submit_url: String,
    endpoints: Vec<LatencyProbeEndpoint>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateManifest {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub publisher_identity_eku: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current_version: String,
    pub available_version: String,
    pub update_available: bool,
    pub publisher_pinned: bool,
}

#[derive(Debug, Clone)]
pub struct StagedUpdate {
    pub version: String,
    pub staged_path: PathBuf,
    pub target_path: PathBuf,
    pub sha256: String,
    pub publisher_identity_eku: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherDeviceAuthorization {
    pub version: u8,
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub expires_at: String,
    pub interval_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
enum LauncherTokenExchange {
    Pending {
        #[serde(rename = "retryAfterSeconds")]
        retry_after_seconds: u64,
        version: u8,
    },
    Authorized {
        #[serde(rename = "accessToken")]
        access_token: String,
        #[serde(rename = "expiresAt")]
        expires_at: String,
        version: u8,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LauncherCredential {
    version: u8,
    api_origin: String,
    access_token: String,
    expires_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LauncherPairingResult {
    pub user_code: String,
    pub expires_at: String,
}

fn quoted_fields(line: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in line.chars() {
        if !quoted {
            if character == '"' {
                quoted = true;
            }
            continue;
        }
        if escaped {
            current.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            values.push(current.clone());
            current.clear();
            quoted = false;
        } else {
            current.push(character);
        }
    }
    values
}

fn vdf_value(contents: &str, key: &str) -> Option<String> {
    contents
        .lines()
        .filter_map(|line| {
            let fields = quoted_fields(line);
            (fields.len() >= 2 && fields[0].eq_ignore_ascii_case(key)).then(|| fields[1].clone())
        })
        .last()
}

fn property_value(contents: &str, key: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let (candidate, value) = line.trim().split_once('=')?;
        candidate
            .eq_ignore_ascii_case(key)
            .then(|| value.trim().to_string())
    })
}

fn replace_property(contents: &str, key: &str, value: &str) -> Result<String, String> {
    if value.is_empty() || !value.chars().all(|character| character.is_ascii_digit()) {
        return Err(format!("{key} must be a numeric Steam build version."));
    }
    let mut found = false;
    let trailing_newline = contents.ends_with('\n');
    let updated = contents
        .lines()
        .map(|line| {
            let matches = line
                .trim()
                .split_once('=')
                .map(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
                .unwrap_or(false);
            if matches {
                found = true;
                format!("{key}={value}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !found {
        return Err(format!("Legacy steam.inf has no {key} property."));
    }
    Ok(if trailing_newline {
        format!("{updated}\n")
    } else {
        updated
    })
}

fn current_inventory_version(game_root: &Path) -> Result<String, String> {
    let current = game_root.join("game").join("csgo").join("steam.inf");
    let contents = fs::read_to_string(&current).map_err(|error| {
        format!(
            "Could not read current CS2 build metadata at {}: {error}",
            current.display()
        )
    })?;
    let version = property_value(&contents, "ClientVersion")
        .ok_or_else(|| "Current CS2 steam.inf has no ClientVersion property.".to_string())?;
    if version.len() < 6
        || version.len() > 12
        || !version.chars().all(|character| character.is_ascii_digit())
    {
        return Err("Current CS2 ClientVersion is invalid.".to_string());
    }
    Ok(version)
}

fn inventory_paths(game_root: &Path) -> (PathBuf, PathBuf) {
    let legacy = game_root.join("csgo").join("steam.inf");
    let backup = game_root.join("csgo").join("steam.inf.b2g-backup");
    (legacy, backup)
}

fn replace_file_preserving_rollback(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "steam.inf has no parent directory.".to_string())?;
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let staged = parent.join(format!("steam.inf.b2g-{nonce}.tmp"));
    let previous = parent.join(format!("steam.inf.b2g-{nonce}.previous"));
    let mut output =
        File::create(&staged).map_err(|error| format!("Could not stage steam.inf: {error}"))?;
    output
        .write_all(contents.as_bytes())
        .map_err(|error| format!("Could not stage steam.inf: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("Could not flush steam.inf: {error}"))?;
    fs::rename(path, &previous)
        .map_err(|error| format!("Could not preserve the active steam.inf: {error}"))?;
    if let Err(error) = fs::rename(&staged, path) {
        let _ = fs::rename(&previous, path);
        let _ = fs::remove_file(&staged);
        return Err(format!(
            "Could not activate the inventory-compatible steam.inf: {error}"
        ));
    }
    let _ = fs::remove_file(previous);
    Ok(())
}

fn sync_inventory_for_root(game_root: &Path, dry_run: bool) -> Result<String, String> {
    let target_version = current_inventory_version(game_root)?;
    let (legacy, backup) = inventory_paths(game_root);
    let contents = fs::read_to_string(&legacy).map_err(|error| {
        format!(
            "Could not read legacy steam.inf at {}: {error}",
            legacy.display()
        )
    })?;
    let current_version = property_value(&contents, "ClientVersion")
        .ok_or_else(|| "Legacy steam.inf has no ClientVersion property.".to_string())?;
    if current_version == target_version {
        return Ok(format!(
            "Steam-owned inventory access is ready on client build {target_version}."
        ));
    }
    let updated = replace_property(&contents, "ClientVersion", &target_version)?;
    if dry_run {
        return Ok(format!(
            "Would synchronize legacy inventory access from client build {current_version} to {target_version}."
        ));
    }
    if !backup.exists() {
        fs::copy(&legacy, &backup)
            .map_err(|error| format!("Could not back up legacy steam.inf: {error}"))?;
    }
    replace_file_preserving_rollback(&legacy, &updated)?;
    Ok(format!(
        "Steam-owned inventory access synchronized to client build {target_version}."
    ))
}

pub fn sync_inventory_access(dry_run: bool) -> Result<String, String> {
    let report = discover();
    if !report.legacy_ready {
        return Err(report
            .blocking_reason
            .unwrap_or_else(|| "Legacy CS:GO is not ready.".to_string()));
    }
    if report.app_id.as_deref() == Some(STANDALONE_APP_ID) {
        return Ok(
            "Valve's standalone CS:GO installation owns its build metadata; no inventory synchronization is required."
                .to_string(),
        );
    }
    let root = report
        .game_root
        .ok_or_else(|| "Legacy CS:GO path is unavailable.".to_string())?;
    sync_inventory_for_root(Path::new(&root), dry_run)
}

pub fn restore_inventory_access(dry_run: bool) -> Result<String, String> {
    let report = discover();
    let root = report
        .game_root
        .ok_or_else(|| "Legacy CS:GO path is unavailable.".to_string())?;
    let (legacy, backup) = inventory_paths(Path::new(&root));
    if !backup.exists() {
        return Ok("No B2G inventory backup exists; nothing was changed.".to_string());
    }
    if dry_run {
        return Ok(format!(
            "Would restore {} from the B2G backup.",
            legacy.display()
        ));
    }
    let contents = fs::read_to_string(&backup)
        .map_err(|error| format!("Could not read the B2G steam.inf backup: {error}"))?;
    replace_file_preserving_rollback(&legacy, &contents)?;
    fs::remove_file(&backup).map_err(|error| {
        format!("Original steam.inf was restored, but its backup could not be removed: {error}")
    })?;
    Ok(
        "Original legacy steam.inf restored. Steam inventory synchronization is disabled."
            .to_string(),
    )
}

fn steam_roots() -> Vec<PathBuf> {
    let mut roots = BTreeSet::new();
    #[cfg(windows)]
    if let Some(root)=setup::registered_steam_root(){roots.insert(root);}
    if let Some(root) = env::var_os("AFTERTICK_STEAM_ROOT") {
        roots.insert(PathBuf::from(root));
    }
    if let Some(root) = env::var_os("ProgramFiles(x86)") {
        roots.insert(PathBuf::from(root).join("Steam"));
    }
    if let Some(root) = env::var_os("ProgramFiles") {
        roots.insert(PathBuf::from(root).join("Steam"));
    }
    if cfg!(windows) {
        roots.insert(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    }
    roots.into_iter().collect()
}

fn libraries(root: &Path) -> Vec<PathBuf> {
    let mut values = BTreeSet::from([root.to_path_buf()]);
    let library_file = root.join("steamapps").join("libraryfolders.vdf");
    if let Ok(contents) = fs::read_to_string(library_file) {
        for line in contents.lines() {
            let fields = quoted_fields(line);
            if fields.len() >= 2 && fields[0].eq_ignore_ascii_case("path") {
                values.insert(PathBuf::from(&fields[1]));
            }
        }
    }
    values.into_iter().collect()
}

fn empty_doctor_report() -> DoctorReport {
    DoctorReport {
        launcher_version: env!("CARGO_PKG_VERSION").to_string(),
        steam_executable: None,
        steam_root: None,
        app_id: None,
        install_kind: None,
        app_manifest: None,
        app_installed: false,
        game_root: None,
        beta_key: None,
        legacy_binary: None,
        legacy_ready: false,
        inventory_access_ready: false,
        inventory_client_version: None,
        current_client_version: None,
        update_publisher_pinned: UPDATE_PUBLISHER_IDENTITY_EKU.is_some(),
        blocking_reason: None,
    }
}

fn inspect_legacy_install(
    steam_root: &Path,
    library: &Path,
    app_id: &str,
    standalone: bool,
) -> Option<DoctorReport> {
    let manifest_path = library
        .join("steamapps")
        .join(format!("appmanifest_{app_id}.acf"));
    let contents = fs::read_to_string(&manifest_path).ok()?;
    let directory = vdf_value(&contents, "installdir")?;
    let game_root = library.join("steamapps").join("common").join(directory);
    let legacy_binary = game_root.join("csgo.exe");
    let beta_key = vdf_value(&contents, "BetaKey");
    let legacy_inf = game_root.join("csgo").join("steam.inf");
    let legacy_version = fs::read_to_string(&legacy_inf)
        .ok()
        .and_then(|value| property_value(&value, "ClientVersion"));
    let current_version = if standalone {
        legacy_version.clone()
    } else {
        current_inventory_version(&game_root).ok()
    };
    let download_complete = setup::manifest_ready(&contents);
    let legacy_ready = download_complete && legacy_binary.is_file()
        && legacy_version.is_some()
        && (standalone || beta_key.as_deref() == Some("csgo_legacy"));
    let blocking_reason = if legacy_ready {
        None
    } else if !standalone && beta_key.as_deref() != Some("csgo_legacy") {
        Some("CS:GO is not installed. Choose Install in the B2G launcher to download it through Steam.".to_string())
    } else if !download_complete {
        Some("Steam is downloading or verifying CS:GO. Setup will continue when Steam finishes.".to_string())
    } else if !legacy_binary.is_file() || legacy_version.is_none() {
        Some(format!(
            "Steam reports {}, but its legacy CS:GO files are incomplete; verify App {app_id} in Steam.",
            if standalone {
                "standalone CS:GO"
            } else {
                "the csgo_legacy branch"
            }
        ))
    } else {
        Some(
            "Install Valve's standalone Counter-Strike: Global Offensive (App 4465480), or select csgo_legacy for App 730."
                .to_string(),
        )
    };
    Some(DoctorReport {
        launcher_version: env!("CARGO_PKG_VERSION").to_string(),
        steam_executable: Some(steam_root.join("steam.exe").display().to_string()),
        steam_root: Some(steam_root.display().to_string()),
        app_id: Some(app_id.to_string()),
        install_kind: Some(if standalone {
            "standalone".to_string()
        } else {
            "app730-legacy".to_string()
        }),
        app_manifest: Some(manifest_path.display().to_string()),
        app_installed: true,
        game_root: Some(game_root.display().to_string()),
        beta_key,
        legacy_binary: legacy_binary
            .is_file()
            .then(|| legacy_binary.display().to_string()),
        legacy_ready,
        inventory_access_ready: if standalone {
            legacy_version.is_some()
        } else {
            legacy_version.is_some() && legacy_version == current_version
        },
        inventory_client_version: legacy_version,
        current_client_version: current_version,
        update_publisher_pinned: UPDATE_PUBLISHER_IDENTITY_EKU.is_some(),
        blocking_reason,
    })
}

fn discover_from_roots(roots: &[PathBuf]) -> DoctorReport {
    let mut report = empty_doctor_report();
    let steam_roots = roots
        .iter()
        .filter(|root| root.join("steam.exe").is_file())
        .collect::<Vec<_>>();
    if let Some(root) = steam_roots.first() {
        report.steam_executable = Some(root.join("steam.exe").display().to_string());
        report.steam_root = Some(root.display().to_string());
    } else {
        report.blocking_reason = Some("Install Steam for the current Windows account.".to_string());
        return report;
    }

    let mut first_installed = None;
    for (app_id, standalone) in [(STANDALONE_APP_ID, true), (LEGACY_BETA_APP_ID, false)] {
        for root in &steam_roots {
            for library in libraries(root) {
                let Some(candidate) = inspect_legacy_install(root, &library, app_id, standalone)
                else {
                    continue;
                };
                if candidate.legacy_ready {
                    return candidate;
                }
                if first_installed.is_none() {
                    first_installed = Some(candidate);
                }
            }
        }
    }

    if let Some(candidate) = first_installed {
        return candidate;
    }
    report.blocking_reason = Some(
        "Install Valve's standalone Counter-Strike: Global Offensive (App 4465480) in Steam."
            .to_string(),
    );
    report
}

fn discover() -> DoctorReport {
    discover_from_roots(&steam_roots())
}

pub fn doctor() -> Result<DoctorReport, String> {
    Ok(discover())
}

fn valid_host(host: &str) -> bool {
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    host.trim_end_matches('.').split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
    })
}

pub fn validate_server(server: &str) -> Result<(), String> {
    if server.parse::<SocketAddr>().is_ok() {
        return Ok(());
    }
    let (host, port) = server
        .rsplit_once(':')
        .ok_or_else(|| "Server must include host and port.".to_string())?;
    if !valid_host(host) {
        return Err("Server host is invalid.".to_string());
    }
    let port = port
        .parse::<u16>()
        .map_err(|_| "Server port is invalid.".to_string())?;
    if port == 0 {
        return Err("Server port is invalid.".to_string());
    }
    Ok(())
}

fn a2s_sample(address: SocketAddr, timeout: Duration) -> Result<Duration, String> {
    let bind_address = if address.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let socket = UdpSocket::bind(bind_address)
        .map_err(|error| format!("Could not open UDP probe socket: {error}"))?;
    socket
        .set_read_timeout(Some(timeout))
        .map_err(|error| format!("Could not set UDP probe timeout: {error}"))?;
    socket
        .set_write_timeout(Some(timeout))
        .map_err(|error| format!("Could not set UDP probe timeout: {error}"))?;
    socket
        .connect(address)
        .map_err(|error| format!("Could not connect UDP probe socket: {error}"))?;

    let started_at = Instant::now();
    let mut query = b"\xff\xff\xff\xffTSource Engine Query\0".to_vec();
    socket
        .send(&query)
        .map_err(|error| format!("Could not send A2S probe: {error}"))?;
    let mut response = [0_u8; 2048];
    let mut received = socket
        .recv(&mut response)
        .map_err(|error| format!("A2S probe did not receive a response: {error}"))?;
    if received >= 9 && response[..5] == [0xff, 0xff, 0xff, 0xff, 0x41] {
        query.extend_from_slice(&response[5..9]);
        socket
            .send(&query)
            .map_err(|error| format!("Could not answer A2S challenge: {error}"))?;
        received = socket
            .recv(&mut response)
            .map_err(|error| format!("A2S challenge did not receive a response: {error}"))?;
    }
    if received < 5 || response[..4] != [0xff, 0xff, 0xff, 0xff] {
        return Err("A2S probe received an invalid Source response.".to_string());
    }
    Ok(started_at.elapsed())
}

pub fn probe_latency(
    server: &str,
    samples: u8,
    timeout: Duration,
) -> Result<LatencyReport, String> {
    validate_server(server)?;
    if !(1..=10).contains(&samples) {
        return Err("Latency samples must be between 1 and 10.".to_string());
    }
    let address = server
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve probe server: {error}"))?
        .next()
        .ok_or_else(|| "Probe server resolved to no address.".to_string())?;
    probe_latency_at(server, address, samples, timeout)
}

fn probe_latency_at(
    server: &str,
    address: SocketAddr,
    samples: u8,
    timeout: Duration,
) -> Result<LatencyReport, String> {
    let mut durations = Vec::new();
    for _ in 0..samples {
        if let Ok(duration) = a2s_sample(address, timeout) {
            durations.push(duration.as_secs_f64() * 1_000.0);
        }
    }
    durations.sort_by(f64::total_cmp);
    let successful_samples = durations.len() as u8;
    let percentile = |value: f64| -> Option<f64> {
        if durations.is_empty() {
            return None;
        }
        let index = ((durations.len() as f64 * value).ceil() as usize)
            .saturating_sub(1)
            .min(durations.len() - 1);
        Some((durations[index] * 10.0).round() / 10.0)
    };
    Ok(LatencyReport {
        server: server.to_string(),
        requested_samples: samples,
        successful_samples,
        median_ms: percentile(0.5),
        p95_ms: percentile(0.95),
        packet_loss_percent: ((samples - successful_samples) as f64 / samples as f64 * 1_000.0)
            .round()
            / 10.0,
    })
}

fn public_ipv4(address: std::net::Ipv4Addr) -> bool {
    let [first, second, third, _] = address.octets();
    !(first == 0
        || first == 10
        || first == 127
        || first >= 224
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 168)
        || (first == 192 && second == 0 && third <= 2)
        || (first == 198 && (second == 18 || second == 19))
        || (first == 198 && second == 51 && third == 100)
        || (first == 203 && second == 0 && third == 113))
}

fn public_probe_address(address: SocketAddr) -> bool {
    match address.ip() {
        IpAddr::V4(ipv4) => public_ipv4(ipv4),
        IpAddr::V6(ipv6) => {
            if let Some(ipv4) = ipv6.to_ipv4_mapped() {
                return public_ipv4(ipv4);
            }
            let segments = ipv6.segments();
            !ipv6.is_unspecified()
                && !ipv6.is_loopback()
                && !ipv6.is_multicast()
                && segments[0] & 0xfe00 != 0xfc00
                && segments[0] & 0xffc0 != 0xfe80
                && segments[0] & 0xffc0 != 0xfec0
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        }
    }
}

fn probe_latency_from_protocol(
    server: &str,
    samples: u8,
    timeout: Duration,
) -> Result<LatencyReport, String> {
    validate_server(server)?;
    if !(1..=10).contains(&samples) {
        return Err("Latency samples must be between 1 and 10.".to_string());
    }
    let address = server
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve probe server: {error}"))?
        .next()
        .ok_or_else(|| "Probe server resolved to no address.".to_string())?;
    if !cfg!(debug_assertions) && !public_probe_address(address) {
        return Err("Release launchers refuse private or non-routable probe targets.".to_string());
    }
    probe_latency_at(server, address, samples, timeout)
}

fn valid_challenge_id(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, character)| {
            if [8, 13, 18, 23].contains(&index) {
                character == '-'
            } else {
                character.is_ascii_hexdigit()
            }
        })
}

fn validate_probe_submit_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "Probe submission URL is invalid.".to_string())?;
    let loopback_http = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if (url.scheme() != "https" && !loopback_http)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Probe submission must use a credential-free HTTPS URL.".to_string());
    }
    Ok(())
}

impl LatencyProbeRequest {
    fn from_deep_link(value: &str) -> Result<Self, String> {
        let url = Url::parse(value).map_err(|_| "Malformed B2G deep link.".to_string())?;
        if url.scheme() != "b2g" || url.host_str() != Some("probe") {
            return Err("Unsupported B2G deep link.".to_string());
        }
        let mut challenge_id = None;
        let mut token = None;
        let mut submit_url = None;
        let mut targets = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "challenge" => challenge_id = Some(value.into_owned()),
                "token" => token = Some(value.into_owned()),
                "submit" => submit_url = Some(value.into_owned()),
                "targets" => targets = Some(value.into_owned()),
                _ => {}
            }
        }
        let challenge_id =
            challenge_id.ok_or_else(|| "Probe link has no challenge.".to_string())?;
        if !valid_challenge_id(&challenge_id) {
            return Err("Probe challenge identifier is invalid.".to_string());
        }
        let token = token.ok_or_else(|| "Probe link has no submission token.".to_string())?;
        if token.len() != 64 || !token.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err("Probe submission token is invalid.".to_string());
        }
        let submit_url =
            submit_url.ok_or_else(|| "Probe link has no submission URL.".to_string())?;
        validate_probe_submit_url(&submit_url)?;
        let encoded_targets = targets.ok_or_else(|| "Probe link has no targets.".to_string())?;
        let target_bytes = URL_SAFE_NO_PAD
            .decode(encoded_targets)
            .map_err(|_| "Probe targets are invalid.".to_string())?;
        if target_bytes.len() > 8 * 1024 {
            return Err("Probe targets are too large.".to_string());
        }
        let endpoints: Vec<LatencyProbeEndpoint> = serde_json::from_slice(&target_bytes)
            .map_err(|_| "Probe targets are invalid.".to_string())?;
        if endpoints.is_empty() || endpoints.len() > 8 {
            return Err("Probe link must contain between one and eight targets.".to_string());
        }
        let mut regions = BTreeSet::new();
        for endpoint in &endpoints {
            if endpoint.region.is_empty()
                || endpoint.region.len() > 64
                || endpoint.region.contains(['\r', '\n'])
                || !regions.insert(endpoint.region.clone())
            {
                return Err("Probe target regions are invalid or duplicated.".to_string());
            }
            validate_server(&endpoint.server)?;
            if !(1..=10).contains(&endpoint.samples) {
                return Err("Probe target sample count is invalid.".to_string());
            }
        }
        Ok(Self {
            challenge_id,
            token: token.to_ascii_lowercase(),
            submit_url,
            endpoints,
        })
    }
}

fn canonical_latency_submission(submission: &LatencyProbeSubmission) -> String {
    let mut fields = vec![
        submission.version.to_string(),
        submission.challenge_id.clone(),
    ];
    for measurement in &submission.measurements {
        fields.extend([
            measurement.region.clone(),
            measurement.server.clone(),
            measurement.requested_samples.to_string(),
            measurement.successful_samples.to_string(),
            measurement
                .median_ms
                .map(|value| format!("{value:.1}"))
                .unwrap_or_else(|| "-".to_string()),
            measurement
                .p95_ms
                .map(|value| format!("{value:.1}"))
                .unwrap_or_else(|| "-".to_string()),
            format!("{:.1}", measurement.packet_loss_percent),
        ]);
    }
    fields.join("\n")
}

fn hmac_sha256_hex(key: &str, value: &str) -> Result<String, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes())
        .map_err(|_| "Probe submission key is invalid.".to_string())?;
    mac.update(value.as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn run_latency_probe(request: &LatencyProbeRequest, dry_run: bool) -> Result<String, String> {
    if !dry_run {
        let report = discover();
        if !report.legacy_ready {
            return Err(report
                .blocking_reason
                .unwrap_or_else(|| "Legacy CS:GO is not ready.".to_string()));
        }
    }
    if dry_run {
        return Ok(format!(
            "Validated {} regional probe target(s) for challenge {}.",
            request.endpoints.len(),
            request.challenge_id
        ));
    }
    let measurements = request
        .endpoints
        .iter()
        .map(|endpoint| {
            let report = probe_latency_from_protocol(
                &endpoint.server,
                endpoint.samples,
                Duration::from_millis(750),
            )?;
            Ok(LatencyProbeMeasurement {
                region: endpoint.region.clone(),
                server: endpoint.server.clone(),
                requested_samples: report.requested_samples,
                successful_samples: report.successful_samples,
                median_ms: report.median_ms,
                p95_ms: report.p95_ms,
                packet_loss_percent: report.packet_loss_percent,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let submission = LatencyProbeSubmission {
        version: 1,
        challenge_id: request.challenge_id.clone(),
        measurements,
    };
    let signature = hmac_sha256_hex(&request.token, &canonical_latency_submission(&submission))?;
    let body = serde_json::to_string(&submission)
        .map_err(|error| format!("Could not encode latency report: {error}"))?;
    update_agent()
        .post(&request.submit_url)
        .header("Authorization", &format!("Bearer {}", request.token))
        .header("Content-Type", "application/json")
        .header("X-B2G-Probe-Signature", &signature)
        .send(body)
        .map_err(|error| format!("Could not submit latency report: {error}"))?;
    Ok(format!(
        "Submitted {} signed regional measurement(s).",
        submission.measurements.len()
    ))
}

pub fn handle_protocol(value: &str, dry_run: bool) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "Malformed B2G deep link.".to_string())?;
    match url.host_str() {
        Some("connect") => connect(&ConnectRequest::from_deep_link(value)?, dry_run),
        Some("probe") => run_latency_probe(&LatencyProbeRequest::from_deep_link(value)?, dry_run),
        _ => Err("Unsupported B2G deep link.".to_string()),
    }
}

fn valid_password(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

fn valid_owned_inventory_bundle(bundle: &OwnedInventoryBundle) -> Result<(), String> {
    if bundle.version != 1
        || bundle
            .inventory_version
            .is_some_and(|version| version > 9_007_199_254_740_991)
        || bundle.match_id.len() != 36
        || !bundle
            .match_id
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
        || bundle.expires_at.len() < 20
        || bundle.expires_at.len() > 40
        || bundle.schema_sha256.len() != 64
        || !bundle
            .schema_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || bundle.players.len() > 14
    {
        return Err("Owned inventory bundle metadata is invalid.".to_string());
    }

    let mut player_ids = BTreeSet::new();
    let mut steam_ids = BTreeSet::new();
    for player in &bundle.players {
        if player.player_id.len() != 36
            || !player
                .player_id
                .chars()
                .all(|character| character.is_ascii_hexdigit() || character == '-')
            || player.steam_id.len() != 17
            || !player
                .steam_id
                .chars()
                .all(|character| character.is_ascii_digit())
            || !player_ids.insert(&player.player_id)
            || !steam_ids.insert(&player.steam_id)
            || player.items.len() > 512
        {
            return Err("Owned inventory player data is invalid.".to_string());
        }

        let mut asset_ids = BTreeSet::new();
        for item in &player.items {
            let asset_id = item
                .asset_id
                .parse::<u64>()
                .map_err(|_| "Owned inventory asset ID is invalid.".to_string())?;
            if asset_id == 0
                || item.ownership_generation.as_ref().is_some_and(|value| {
                    value.parse::<i64>().map_or(true, |generation| {
                        generation < 0 || generation.to_string() != *value
                    })
                })
                || !asset_ids.insert(asset_id)
                || !matches!(item.source.as_str(), "steam" | "b2g")
                || !matches!(item.item_kind.as_str(), "case" | "key" | "cosmetic")
                || (item.source == "steam" && item.item_kind != "cosmetic")
                || !(1..=65_535).contains(&item.definition_index)
                || item.weapon_key.len() < 2
                || item.weapon_key.len() > 32
                || !item.weapon_key.chars().all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
                })
                || item
                    .paint_wear
                    .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
                || item.custom_name.as_ref().is_some_and(|value| {
                    value.is_empty()
                        || value.chars().count() > 100
                        || value.chars().any(char::is_control)
                })
                || item.loadout_slot > 63
                || item
                    .spray_tint_id
                    .is_some_and(|value| !(1..=19).contains(&value))
                || item
                    .sprays_remaining
                    .is_some_and(|value| !(1..=50).contains(&value))
                || (matches!(item.definition_index, 1348 | 1349)
                    != (item.spray_kit_id.is_some() && item.spray_tint_id.is_some()))
                || (item.definition_index == 1348 && item.sprays_remaining.is_some())
                || (item.definition_index == 1349 && item.sprays_remaining.is_none())
                || (!matches!(item.definition_index, 1348 | 1349)
                    && (item.spray_kit_id.is_some()
                        || item.spray_tint_id.is_some()
                        || item.sprays_remaining.is_some()))
                || item.stickers.len() > 6
                || (item.equipped && item.item_kind != "cosmetic")
            {
                return Err("Owned inventory item data is invalid.".to_string());
            }

            let mut sticker_slots = BTreeSet::new();
            for sticker in &item.stickers {
                if sticker.slot > 5
                    || !sticker_slots.insert(sticker.slot)
                    || sticker
                        .wear
                        .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
                    || sticker
                        .scale
                        .is_some_and(|value| !value.is_finite() || !(0.0..=100.0).contains(&value))
                    || sticker.rotation.is_some_and(|value| {
                        !value.is_finite() || !(-360.0..=360.0).contains(&value)
                    })
                {
                    return Err("Owned inventory sticker data is invalid.".to_string());
                }
            }
        }
    }
    Ok(())
}

fn kv(value: impl std::fmt::Display) -> String {
    let text = value.to_string();
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn owned_item_attributes(item: &OwnedItem) -> BTreeMap<u32, String> {
    let mut attributes = BTreeMap::new();
    if let Some(value) = item.paint_index {
        attributes.insert(6, value.to_string());
    }
    if let Some(value) = item.paint_seed {
        attributes.insert(7, value.to_string());
    }
    if let Some(value) = item.paint_wear {
        attributes.insert(8, value.to_string());
    }
    if let Some(value) = item.kill_eater_value {
        attributes.insert(80, value.to_string());
    }
    if let Some(value) = item.kill_eater_score_type {
        attributes.insert(81, value.to_string());
    }
    if let Some(value) = item.spray_kit_id {
        attributes.insert(113, value.to_string());
    }
    if let Some(value) = item.sprays_remaining {
        attributes.insert(232, value.to_string());
    }
    if let Some(value) = item.spray_tint_id {
        attributes.insert(233, value.to_string());
    }
    for sticker in &item.stickers {
        let base = 113 + sticker.slot * 4;
        attributes.insert(base, sticker.sticker_id.to_string());
        if let Some(value) = sticker.wear {
            attributes.insert(base + 1, value.to_string());
        }
        if let Some(value) = sticker.scale {
            attributes.insert(base + 2, value.to_string());
        }
        if let Some(value) = sticker.rotation {
            attributes.insert(base + 3, value.to_string());
        }
    }
    attributes
}

fn render_owned_inventory_bundle(bundle: &OwnedInventoryBundle) -> String {
    let mut lines = vec![
        format!("{} {}", kv("format_version"), kv(1)),
        format!("{} {}", kv("match_id"), kv(&bundle.match_id)),
        format!("{} {}", kv("expires_at"), kv(&bundle.expires_at)),
        format!("{} {}", kv("schema_sha256"), kv(&bundle.schema_sha256)),
        kv("players"),
        "{".to_string(),
    ];
    for player in &bundle.players {
        lines.extend([
            format!("  {}", kv(&player.steam_id)),
            "  {".to_string(),
            format!("    {}", kv("items")),
            "    {".to_string(),
        ]);
        for item in &player.items {
            lines.extend([
                format!("      {}", kv(&item.asset_id)),
                "      {".to_string(),
                format!(
                    "        {} {}",
                    kv("inventory"),
                    kv(item.inventory_position)
                ),
                format!("        {} {}", kv("def_index"), kv(item.definition_index)),
                format!("        {} {}", kv("source"), kv(&item.source)),
                format!("        {} {}", kv("ownership_generation"), kv(item.ownership_generation.as_deref().unwrap_or("0"))),
                format!("        {} {}", kv("item_kind"), kv(&item.item_kind)),
                format!("        {} {}", kv("level"), kv(1)),
                format!("        {} {}", kv("quality"), kv(item.quality)),
                format!("        {} {}", kv("flags"), kv(0)),
                format!("        {} {}", kv("origin"), kv(item.origin)),
                format!(
                    "        {} {}",
                    kv("custom_name"),
                    kv(item.custom_name.as_deref().unwrap_or(""))
                ),
                format!("        {} {}", kv("in_use"), kv(0)),
                format!("        {} {}", kv("rarity"), kv(item.rarity)),
                format!("        {} {}", kv("loadout_slot"), kv(item.loadout_slot)),
                format!("        {}", kv("attributes")),
                "        {".to_string(),
            ]);
            for (definition_index, value) in owned_item_attributes(item) {
                lines.push(format!("          {} {}", kv(definition_index), kv(value)));
            }
            lines.extend([
                "        }".to_string(),
                format!("        {}", kv("equipped_state")),
                "        {".to_string(),
            ]);
            if item.equipped {
                if item.loadout_slot == 55 {
                    lines.push(format!("          {} {}", kv(0), kv(55)));
                } else {
                    lines.push(format!("          {} {}", kv(2), kv(item.loadout_slot)));
                    lines.push(format!("          {} {}", kv(3), kv(item.loadout_slot)));
                }
            }
            lines.extend(["        }".to_string(), "      }".to_string()]);
        }
        lines.extend(["    }".to_string(), "  }".to_string()]);
    }
    lines.extend(["}".to_string(), String::new()]);
    lines.join("\n")
}

fn fetch_owned_inventory_bundle(
    endpoint: &str,
    token: &str,
) -> Result<OwnedInventoryBundle, String> {
    validate_https(endpoint, "Inventory endpoint")?;
    let mut response = update_agent()
        .get(endpoint)
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .http_status_as_error(false)
        .build()
        .call()
        .map_err(|error| format!("Could not fetch owned inventory: {error}"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut body = Vec::new();
        let _ = response.body_mut().as_reader().take(4096).read_to_end(&mut body);
        return Err(inventory_response_error(status, &body));
    }
    let mut body = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_INVENTORY_BUNDLE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| format!("Could not read owned inventory: {error}"))?;
    if body.len() as u64 > MAX_INVENTORY_BUNDLE_BYTES {
        return Err("Owned inventory bundle exceeds 8 MiB.".to_string());
    }
    let bundle: OwnedInventoryBundle = serde_json::from_slice(&body)
        .map_err(|error| format!("Owned inventory response is invalid: {error}"))?;
    valid_owned_inventory_bundle(&bundle)?;
    Ok(bundle)
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Inventory policy path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create inventory policy directory: {error}"))?;
    let staged = parent.join(format!(
        ".b2g-inventory-{}-{}.tmp",
        std::process::id(),
        now_unix()
    ));
    let mut file = File::create(&staged)
        .map_err(|error| format!("Could not stage owned inventory policy: {error}"))?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write owned inventory policy: {error}"))?;
    if let Err(error) = fs::rename(&staged, path) {
        let _ = fs::remove_file(path);
        fs::rename(&staged, path)
            .map_err(|_| format!("Could not activate owned inventory policy: {error}"))?;
    }
    Ok(())
}

fn sha256_bytes(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

fn file_has_sha256(path: &Path, expected: &str) -> bool {
    path.is_file() && sha256_file(path).is_ok_and(|actual| actual.eq_ignore_ascii_case(expected))
}

fn validate_embedded_gc_assets() -> Result<(), String> {
    if sha256_bytes(GC_CLIENT_WRAPPER) != GC_CLIENT_WRAPPER_SHA256
        || sha256_bytes(GC_LIBRARY) != GC_LIBRARY_SHA256
    {
        return Err("Embedded local-GC artifacts failed their pinned SHA-256 checks.".to_string());
    }
    Ok(())
}

fn install_managed_file(
    path: &Path,
    contents: &[u8],
    expected_sha256: &str,
    backup: Option<&Path>,
    must_exist_or_have_backup: bool,
    previous_sha256: &[&str],
) -> Result<bool, String> {
    if file_has_sha256(path, expected_sha256) {
        return Ok(false);
    }
    if path.exists() {
        if let Some(backup) = backup
            && !backup.exists()
        {
            let original = fs::read(path).map_err(|error| {
                format!("Could not read {} before backup: {error}", path.display())
            })?;
            // An upgrade replaces our own file; it is not an original to restore.
            if !previous_sha256.contains(&sha256_bytes(&original).as_str()) {
                atomic_write(backup, &original)?;
                if sha256_file(path)? != sha256_file(backup)? {
                    return Err(format!(
                        "Backup verification failed for {}.",
                        path.display()
                    ));
                }
            }
        }
    } else if must_exist_or_have_backup && backup.is_none_or(|backup| !backup.exists()) {
        return Err(format!(
            "Required Valve executable is missing at {}.",
            path.display()
        ));
    }
    atomic_write(path, contents)?;
    if !file_has_sha256(path, expected_sha256) {
        return Err(format!(
            "Installed file failed verification: {}.",
            path.display()
        ));
    }
    Ok(true)
}

fn restore_managed_file(
    path: &Path,
    managed_sha256: &str,
    backup: Option<&Path>,
    previous_sha256: &[&str],
) -> Result<bool, String> {
    if !path.exists() && backup.is_none_or(|backup| !backup.is_file()) {
        return Ok(false);
    }
    if path.exists() && !file_has_sha256(path, managed_sha256) {
        return Err(format!(
            "Refusing to overwrite unrecognized file during uninstall: {}.",
            path.display()
        ));
    }
    if let Some(backup) = backup {
        if backup.is_file() {
            let original = fs::read(backup)
                .map_err(|error| format!("Could not read backup {}: {error}", backup.display()))?;
            let original_sha256 = sha256_bytes(&original);
            if original_sha256 == managed_sha256
                || previous_sha256.contains(&original_sha256.as_str())
            {
                // Older installers sometimes backed up an earlier B2G version.
                // Remove only positively identified managed bytes, including when
                // a previous interrupted uninstall already removed the target.
                if path.exists() {
                    fs::remove_file(path).map_err(|error| {
                        format!("Could not remove managed file {}: {error}", path.display())
                    })?;
                }
                fs::remove_file(backup).map_err(|error| {
                    format!("Could not remove managed backup {}: {error}", backup.display())
                })?;
                return Ok(true);
            }
            atomic_write(path, &original)?;
            if !file_has_sha256(path, &original_sha256) {
                return Err(format!(
                    "Restored backup failed verification: {}.",
                    path.display()
                ));
            }
            fs::remove_file(backup)
                .map_err(|error| format!("Could not remove restored backup: {error}"))?;
            return Ok(true);
        }
    }
    fs::remove_file(path)
        .map_err(|error| format!("Could not remove managed file {}: {error}", path.display()))?;
    Ok(true)
}

fn ensure_gc_for_root(game_root: &Path) -> Result<bool, String> {
    validate_embedded_gc_assets()?;
    if !game_root.join("bin").join("launcher.dll").is_file() {
        return Err("The selected game root has no legacy bin/launcher.dll.".to_string());
    }
    let wrapper = game_root.join("csgo.exe");
    let wrapper_backup = game_root.join("csgo.exe.b2g-original");
    let gc_directory = game_root.join("csgo_gc");
    let library = gc_directory.join("csgo_gc.dll");
    let library_backup = gc_directory.join("csgo_gc.dll.b2g-original");
    let config = gc_directory.join("config.txt");
    let config_backup = gc_directory.join("config.txt.b2g-original");
    let license = gc_directory.join("LICENSE.csgo-gc");
    let provenance = gc_directory.join("B2G-PROVENANCE.md");
    #[cfg(windows)]
    if !running_game_process_ids(&wrapper)?.is_empty() {
        // A live handoff may verify an unchanged installation, but must never
        // begin a partial repair of files being used by the running client.
        if file_has_sha256(&wrapper, GC_CLIENT_WRAPPER_SHA256)
            && file_has_sha256(&library, GC_LIBRARY_SHA256)
            && file_has_sha256(&config, &sha256_bytes(GC_CONFIG.as_bytes()))
            && file_has_sha256(&license, &sha256_bytes(GC_LICENSE))
            && file_has_sha256(&provenance, &sha256_bytes(GC_PROVENANCE))
        {
            return Ok(false);
        }
        return Err("Close CS:GO before updating its B2G files, then press Play again.".to_string());
    }
    fs::create_dir_all(&gc_directory)
        .map_err(|error| format!("Could not create local-GC directory: {error}"))?;

    let mut changed = false;
    changed |= install_managed_file(
        &library,
        GC_LIBRARY,
        GC_LIBRARY_SHA256,
        Some(&library_backup),
        false,
        GC_LIBRARY_PREVIOUS_SHA256,
    )?;
    if file_has_sha256(&config, GC_CONFIG_WRAPPED_V1_SHA256) {
        atomic_write(&config, GC_CONFIG.as_bytes())?;
        if !file_has_sha256(&config, &sha256_bytes(GC_CONFIG.as_bytes())) {
            return Err(format!(
                "Migrated file failed verification: {}.",
                config.display()
            ));
        }
        changed = true;
    } else {
        changed |= install_managed_file(
            &config,
            GC_CONFIG.as_bytes(),
            &sha256_bytes(GC_CONFIG.as_bytes()),
            Some(&config_backup),
            false,
            &[GC_CONFIG_WRAPPED_V1_SHA256],
        )?;
    }
    changed |= install_managed_file(&license, GC_LICENSE, &sha256_bytes(GC_LICENSE), None, false, &[])?;
    changed |= install_managed_file(
        &provenance,
        GC_PROVENANCE,
        &sha256_bytes(GC_PROVENANCE),
        None,
        false,
        &[],
    )?;
    // Activate the wrapper last so any earlier failure leaves Valve's launcher
    // untouched and directly runnable.
    changed |= install_managed_file(
        &wrapper,
        GC_CLIENT_WRAPPER,
        GC_CLIENT_WRAPPER_SHA256,
        Some(&wrapper_backup),
        true,
        &[],
    )?;
    Ok(changed)
}

fn game_root_from_doctor() -> Result<PathBuf, String> {
    let report = discover();
    if !report.legacy_ready {
        return Err(report
            .blocking_reason
            .unwrap_or_else(|| "Legacy CS:GO is not ready.".to_string()));
    }
    report
        .game_root
        .map(PathBuf::from)
        .ok_or_else(|| "Legacy CS:GO game root is unavailable.".to_string())
}

pub fn repair_game(dry_run: bool) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = dry_run;
        return Err("Game repair is only supported on Windows.".to_string());
    }
    #[cfg(windows)]
    {
        let game_root = game_root_from_doctor()?;
        if dry_run {
            validate_embedded_gc_assets()?;
            return Ok(format!(
                "Validated recoverable local-GC repair for {}.",
                game_root.display()
            ));
        }
        require_game_stopped(&game_root)?;
        let changed = ensure_gc_for_root(&game_root)?;
        Ok(format!(
            "B2G local-GC files {} at {}.",
            if changed {
                "were repaired"
            } else {
                "are already current"
            },
            game_root.display()
        ))
    }
}

pub fn uninstall_game(dry_run: bool) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = dry_run;
        return Err("Game uninstall is only supported on Windows.".to_string());
    }
    #[cfg(windows)]
    {
        let game_root = game_root_from_doctor()?;
        uninstall_gc_for_root(&game_root, dry_run)
    }
}

#[cfg(windows)]
fn uninstall_gc_for_root(game_root: &Path, dry_run: bool) -> Result<String, String> {
    // Validate the entire rollback before removing even the first file.
    let gc_directory = game_root.join("csgo_gc");
    let wrapper_backup = game_root.join("csgo.exe.b2g-original");
    if !wrapper_backup.is_file() {
        return Err("Refusing to remove the managed launcher because its Valve backup is missing. Run Steam file verification first.".to_string());
    }
    let files = [
        (
            game_root.join("csgo.exe"),
            GC_CLIENT_WRAPPER_SHA256.to_string(),
        ),
        (
            gc_directory.join("csgo_gc.dll"),
            GC_LIBRARY_SHA256.to_string(),
        ),
        (
            gc_directory.join("config.txt"),
            sha256_bytes(GC_CONFIG.as_bytes()),
        ),
        (
            gc_directory.join("LICENSE.csgo-gc"),
            sha256_bytes(GC_LICENSE),
        ),
        (
            gc_directory.join("B2G-PROVENANCE.md"),
            sha256_bytes(GC_PROVENANCE),
        ),
    ];
    for (path, expected) in &files {
        if path.exists() && !file_has_sha256(path, expected) {
            return Err(format!(
                "Refusing to overwrite unrecognized file during uninstall: {}.",
                path.display()
            ));
        }
    }
    for backup in [
        wrapper_backup,
        gc_directory.join("csgo_gc.dll.b2g-original"),
        gc_directory.join("config.txt.b2g-original"),
    ] {
        if backup.exists() {
            fs::read(&backup)
                .map_err(|error| format!("Could not read backup {}: {error}", backup.display()))?;
        }
    }
    if dry_run {
        return Ok(format!(
            "Validated recoverable local-GC uninstall for {}.",
            game_root.display()
        ));
    }
    require_game_stopped(&game_root)?;
    let gc_directory = game_root.join("csgo_gc");
    let library = gc_directory.join("csgo_gc.dll");
    let config = gc_directory.join("config.txt");
    let license = gc_directory.join("LICENSE.csgo-gc");
    let provenance = gc_directory.join("B2G-PROVENANCE.md");
    restore_managed_file(
        &library,
        GC_LIBRARY_SHA256,
        Some(&gc_directory.join("csgo_gc.dll.b2g-original")),
        GC_LIBRARY_PREVIOUS_SHA256,
    )?;
    restore_managed_file(
        &config,
        &sha256_bytes(GC_CONFIG.as_bytes()),
        Some(&gc_directory.join("config.txt.b2g-original")),
        &[GC_CONFIG_WRAPPED_V1_SHA256],
    )?;
    restore_managed_file(&license, &sha256_bytes(GC_LICENSE), None, &[])?;
    restore_managed_file(&provenance, &sha256_bytes(GC_PROVENANCE), None, &[])?;
    let manifest = gc_directory.join("b2g_owned_manifest.txt");
    if manifest.is_file() {
        fs::remove_file(&manifest)
            .map_err(|error| format!("Could not remove match inventory manifest: {error}"))?;
    }
    restore_managed_file(
        &game_root.join("csgo.exe"),
        GC_CLIENT_WRAPPER_SHA256,
        Some(&game_root.join("csgo.exe.b2g-original")),
        &[],
    )?;
    Ok(format!(
        "B2G local-GC files were removed and the Valve launcher was restored at {}.",
        game_root.display()
    ))
}

pub fn game_diagnostics() -> Result<GameDiagnosticsReport, String> {
    let game_root = game_root_from_doctor()?;
    let gc_directory = game_root.join("csgo_gc");
    Ok(GameDiagnosticsReport {
        game_root: game_root.display().to_string(),
        gc_wrapper_installed: file_has_sha256(
            &game_root.join("csgo.exe"),
            GC_CLIENT_WRAPPER_SHA256,
        ),
        gc_library_installed: file_has_sha256(&gc_directory.join("csgo_gc.dll"), GC_LIBRARY_SHA256),
        original_launcher_backup: game_root.join("csgo.exe.b2g-original").is_file(),
        console_log: game_root
            .join("csgo")
            .join("console.log")
            .display()
            .to_string(),
        gc_log: gc_directory.join("gc_log.txt").display().to_string(),
        inventory_manifest: gc_directory
            .join("b2g_owned_manifest.txt")
            .display()
            .to_string(),
        launcher_log: launcher_log_path().map(|path| path.display().to_string()),
    })
}

fn connection_inventory<'a>(
    match_bundle: &'a OwnedInventoryBundle,
    session_bundle: Option<&'a OwnedInventoryBundle>,
) -> Result<&'a OwnedInventoryBundle, String> {
    valid_owned_inventory_bundle(match_bundle)?;
    let Some(session_bundle) = session_bundle else {
        return Ok(match_bundle);
    };
    valid_owned_inventory_bundle(session_bundle)?;
    if session_bundle.players.len() != 1
        || session_bundle.schema_sha256 != match_bundle.schema_sha256
        || !match_bundle.players.iter().any(|member| {
            member.steam_id == session_bundle.players[0].steam_id
                && member.player_id == session_bundle.players[0].player_id
        })
    {
        return Err(
            "The paired inventory does not belong to this match's authorized player/schema."
                .to_string(),
        );
    }
    // The server receives its own scoped cosmetics manifest. The client must
    // retain the paired account's complete inventory, including cases, keys,
    // pins and sprays, for authenticated in-match inventory operations.
    Ok(session_bundle)
}

fn prepare_owned_inventory(
    request: &ConnectRequest,
    game_root: &Path,
    session_bundle: Option<&OwnedInventoryBundle>,
) -> Result<String, String> {
    let Some(endpoint) = request.inventory_url.as_deref() else {
        if session_bundle.is_some() {
            return Err(
                "The assigned match did not provide an inventory authorization grant.".to_string(),
            );
        }
        log_launcher_event("inventory: no match-scoped ownership grant was supplied");
        return Ok("No match inventory grant was supplied.".to_string());
    };
    let token = request
        .inventory_token
        .as_deref()
        .ok_or_else(|| "Match inventory grant is missing.".to_string())?;
    log_launcher_event("inventory: fetching the signed owned-item bundle");
    let match_bundle = fetch_owned_inventory_bundle(endpoint, token)?;
    let bundle = connection_inventory(&match_bundle, session_bundle)?;
    let item_count = bundle
        .players
        .iter()
        .map(|player| player.items.len())
        .sum::<usize>();
    atomic_write(
        &game_root.join("csgo_gc").join("b2g_owned_manifest.txt"),
        render_owned_inventory_bundle(bundle).as_bytes(),
    )?;
    log_launcher_event(&format!(
        "inventory: activated {} bundle for {} player(s), {item_count} item(s)",
        if session_bundle.is_some() {
            "full paired client"
        } else {
            "match"
        },
        bundle.players.len(),
    ));
    Ok(format!(
        "Loaded {} freshly verified inventory item(s).",
        item_count
    ))
}

impl ConnectRequest {
    pub fn from_deep_link(value: &str) -> Result<Self, String> {
        let url = Url::parse(value).map_err(|_| "Malformed B2G deep link.".to_string())?;
        if url.scheme() != "b2g" || url.host_str() != Some("connect") {
            return Err("Unsupported B2G deep link.".to_string());
        }
        let mut server = None;
        let mut password = None;
        let mut inventory_url = None;
        let mut inventory_token = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "server" => server = Some(value.into_owned()),
                "password" => password = Some(value.into_owned()),
                "inventory" => inventory_url = Some(value.into_owned()),
                "inventory_token" => inventory_token = Some(value.into_owned()),
                _ => {}
            }
        }
        if inventory_url.is_some() != inventory_token.is_some() {
            return Err("Inventory endpoint and grant must be provided together.".to_string());
        }
        if let Some(endpoint) = inventory_url.as_deref() {
            validate_https(endpoint, "Inventory endpoint")?;
        }
        if let Some(token) = inventory_token.as_deref()
            && (token.len() != 64 || !token.chars().all(|character| character.is_ascii_hexdigit()))
        {
            return Err("Inventory grant is invalid.".to_string());
        }
        let request = Self {
            server: server.ok_or_else(|| "Deep link has no server.".to_string())?,
            password: password.ok_or_else(|| "Deep link has no match password.".to_string())?,
            inventory_url,
            inventory_token: inventory_token.map(|token| token.to_ascii_lowercase()),
        };
        validate_server(&request.server)?;
        if !valid_password(&request.password) {
            return Err("Match password is invalid.".to_string());
        }
        Ok(request)
    }
}

pub fn connect(request: &ConnectRequest, dry_run: bool) -> Result<String, String> {
    connect_with_inventory(request, dry_run, None)
}

fn connect_with_inventory(
    request: &ConnectRequest,
    dry_run: bool,
    session_bundle: Option<&OwnedInventoryBundle>,
) -> Result<String, String> {
    log_launcher_event("connect: validating request and discovering the legacy game");
    validate_server(&request.server)?;
    if !valid_password(&request.password) {
        return Err("Match password is invalid.".to_string());
    }
    let report = discover();
    if !dry_run && !report.legacy_ready {
        return Err(report
            .blocking_reason
            .unwrap_or_else(|| "Legacy CS:GO is not ready.".to_string()));
    }
    let app_id = selected_app_id(&report, dry_run)?;
    log_launcher_event(&format!(
        "connect: selected Steam App {app_id} ({})",
        report.install_kind.as_deref().unwrap_or("unknown install")
    ));
    let prepare_inventory = |dry_run| {
        if dry_run && report.app_id.is_none() {
            Ok("Client discovery is deferred in validation-only dry run.".to_string())
        } else if app_id == STANDALONE_APP_ID {
            Ok(
                "Valve standalone metadata is ready; no compatibility patch is required."
                    .to_string(),
            )
        } else {
            report
                .game_root
                .as_deref()
                .map(|root| sync_inventory_for_root(Path::new(root), dry_run))
                .transpose()
                .map(|result| result.unwrap_or_else(|| "Inventory path unavailable.".to_string()))
        }
    };
    if dry_run {
        let inventory = prepare_inventory(true)?;
        log_launcher_event("connect: validation-only request completed");
        return Ok(format!(
            "Validated Steam App {app_id} handoff to {}/<redacted>. {inventory}",
            request.server,
        ));
    }
    #[cfg(windows)]
    ensure_faceit_closed()?;
    prepare_inventory(false)?;
    let game_root = report
        .game_root
        .as_deref()
        .ok_or_else(|| "Legacy CS:GO game root is unavailable.".to_string())?;
    prepare_owned_inventory(request, Path::new(game_root), session_bundle)?;
    let gc_changed = ensure_gc_for_root(Path::new(game_root))?;
    log_launcher_event(&format!(
        "connect: local GC files verified; changed={gc_changed}"
    ));
    let steam = report
        .steam_executable
        .clone()
        .ok_or_else(|| "Steam is not installed.".to_string())?;
    let game_binary = report
        .legacy_binary
        .clone()
        .ok_or_else(|| "Legacy CS:GO executable is unavailable.".to_string())?;
    #[cfg(windows)]
    if gc_changed && verified_source_window(Path::new(&game_binary))?.is_some() {
        return Err(
            "B2G installed the owned-inventory client. Close the currently running CS:GO process, then click Open Launcher again."
                .to_string(),
        );
    }
    source_connect_handoff(
        Path::new(&steam),
        &app_id,
        Path::new(game_root),
        Path::new(&game_binary),
        request,
    )?;
    log_launcher_event("connect: Source command handoff completed");
    Ok(format!(
        "Opened legacy CS:GO through Steam App {app_id} and handed off the connection to {}.",
        request.server
    ))
}

fn selected_app_id(report: &DoctorReport, validation_only: bool) -> Result<String, String> {
    report
        .app_id
        .clone()
        .or_else(|| validation_only.then(|| STANDALONE_APP_ID.to_string()))
        .ok_or_else(|| "Legacy CS:GO Steam App ID is unavailable.".to_string())
}

fn steam_start_arguments(app_id: &str) -> Vec<String> {
    vec![
        "-applaunch".to_string(),
        app_id.to_string(),
        "-novid".to_string(),
        "-condebug".to_string(),
        "-conclearlog".to_string(),
    ]
}

fn source_connect_command(request: &ConnectRequest) -> String {
    format!("password {};connect {};", request.password, request.server)
}

#[cfg(windows)]
fn windows_process_path(process_id: u32) -> Result<PathBuf, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return Err(format!("Could not open process {process_id}."));
    }
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    let queried =
        unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe {
        CloseHandle(process);
    }
    if queried == 0 || length == 0 {
        return Err("Could not read the Source Engine executable path.".to_string());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..length as usize],
    )))
}

#[cfg(windows)]
fn source_window_process(window: windows_sys::Win32::Foundation::HWND) -> Result<PathBuf, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut process_id = 0_u32;
    unsafe {
        GetWindowThreadProcessId(window, &mut process_id);
    }
    if process_id == 0 {
        return Err("Could not identify the Source Engine window process.".to_string());
    }
    windows_process_path(process_id)
        .map_err(|_| "Could not verify the Source Engine window process.".to_string())
}

#[cfg(windows)]
fn same_windows_path(left: &Path, right: &Path) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(windows)]
fn windows_process_is_active(process_id: u32) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            process_id,
        )
    };
    if process.is_null() {
        return Err(format!("Could not open process {process_id}."));
    }
    let wait_result = unsafe { WaitForSingleObject(process, 0) };
    unsafe {
        CloseHandle(process);
    }
    match wait_result {
        WAIT_TIMEOUT => Ok(true),
        WAIT_OBJECT_0 => Ok(false),
        WAIT_FAILED => Err(format!("Could not query process {process_id} state.")),
        state => Err(format!(
            "Windows returned unexpected process {process_id} state {state}."
        )),
    }
}

#[cfg(windows)]
fn running_process_ids_by_name(expected_name: &str) -> Result<Vec<u32>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err("Could not inspect running Windows processes.".to_string());
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    let mut matches = Vec::new();
    while has_entry {
        let name_length = entry
            .szExeFile
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(entry.szExeFile.len());
        let process_name = String::from_utf16_lossy(&entry.szExeFile[..name_length]);
        if process_name.eq_ignore_ascii_case(expected_name)
            && windows_process_is_active(entry.th32ProcessID).unwrap_or(true)
        {
            matches.push(entry.th32ProcessID);
        }
        has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Ok(matches)
}

#[cfg(windows)]
pub(crate) const FACEIT_LAUNCH_BLOCK: &str = "Exit FACEIT from its system tray, then press Play.\n\nFACEIT's desktop overlay conflicts with B2G's in-game inventory client. Closing its window may leave the overlay running; use Exit from the FACEIT system-tray icon.";

#[cfg(windows)]
fn ensure_faceit_closed() -> Result<(), String> {
    let process_ids = running_process_ids_by_name("FACEIT.exe")?;
    if process_ids.is_empty() {
        return Ok(());
    }
    let process_ids = process_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    log_launcher_event(&format!(
        "preflight: FACEIT desktop overlay is running in PID(s) {process_ids}"
    ));
    Err(FACEIT_LAUNCH_BLOCK.to_string())
}

fn inventory_response_error(status: u16, body: &[u8]) -> String {
    let message = serde_json::from_slice::<serde_json::Value>(body).ok()
        .and_then(|value| value.get("error")?.as_str().map(str::to_owned))
        .filter(|message| !message.trim().is_empty());
    if let Some(message) = message {
        let message: String = message.chars().filter(|c| !c.is_control() || *c == '\n').take(512).collect();
        format!("Could not load inventory: {message}")
    } else {
        format!("Could not load inventory (HTTP {status}). Open Launch Help for details.")
    }
}

#[cfg(windows)]
fn require_game_stopped(game_root: &Path) -> Result<(), String> {
    if running_game_process_ids(&game_root.join("csgo.exe"))?.is_empty() {
        Ok(())
    } else {
        Err("Close CS:GO first, then retry from the B2G launcher.".to_string())
    }
}

#[cfg(windows)]
fn running_game_process_ids(expected_game_binary: &Path) -> Result<Vec<u32>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    let expected_name = expected_game_binary
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "Legacy CS:GO executable name is unavailable.".to_string())?;
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err("Could not inspect running Windows processes.".to_string());
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    let mut matches = Vec::new();
    while has_entry {
        let name_length = entry
            .szExeFile
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(entry.szExeFile.len());
        let process_name = String::from_utf16_lossy(&entry.szExeFile[..name_length]);
        if process_name.eq_ignore_ascii_case(&expected_name)
            && windows_process_is_active(entry.th32ProcessID).unwrap_or(false)
            && windows_process_path(entry.th32ProcessID)
                .is_ok_and(|path| same_windows_path(&path, expected_game_binary))
        {
            matches.push(entry.th32ProcessID);
        }
        has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Ok(matches)
}

fn gc_inventory_status(log: &str) -> Option<Result<usize, String>> {
    for line in log.lines().rev() {
        if let Some(rest) = line.strip_prefix("B2G published ")
            && let Some((count, _)) = rest.split_once(" exact owned items to client SOCache")
            && let Ok(count) = count.parse::<usize>()
        {
            return Some(Ok(count));
        }
        if let Some(error) = line.strip_prefix("B2G owned inventory unavailable for ")
            && let Some((_, reason)) = error.split_once(": ")
        {
            return Some(Err(format!(
                "The in-game inventory GC rejected the owned-item manifest: {reason}."
            )));
        }
        if line == "B2G local GC initialized (owned_only=0, dedicated=0)" {
            return Some(Err(
                "The in-game inventory GC started without B2G owned-only policy.".to_string(),
            ));
        }
    }
    None
}

#[cfg(windows)]
fn wait_for_gc_inventory(game_root: &Path, expected_game_binary: &Path) -> Result<(), String> {
    log_launcher_event("inventory: waiting for the in-game GC to publish owned items");
    let log_path = game_root.join("csgo_gc").join("gc_log.txt");
    let deadline = Instant::now() + GC_INVENTORY_WAIT;
    loop {
        if let Ok(log) = fs::read_to_string(&log_path)
            && let Some(status) = gc_inventory_status(&log)
        {
            let item_count = status?;
            log_launcher_event(&format!(
                "inventory: in-game GC confirmed {item_count} owned item(s)"
            ));
            return Ok(());
        }
        if running_game_process_ids(expected_game_binary)?.is_empty() {
            return Err(
                "CS:GO exited before its inventory GC confirmed the owned-item manifest."
                    .to_string(),
            );
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "The in-game inventory GC did not confirm the owned-item manifest within 45 seconds. Diagnostic log: {}",
                log_path.display()
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(windows)]
fn verified_source_window(
    expected_game_binary: &Path,
) -> Result<Option<windows_sys::Win32::Foundation::HWND>, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowA;

    let window = unsafe { FindWindowA(b"Valve001\0".as_ptr(), std::ptr::null()) };
    if window.is_null() {
        return Ok(None);
    }
    let actual_game_binary = source_window_process(window)?;
    if !same_windows_path(&actual_game_binary, expected_game_binary) {
        return Err(format!(
            "Another Source game owns the connection window at {}. Close it before joining B2G.",
            actual_game_binary.display()
        ));
    }
    Ok(Some(window))
}

#[cfg(windows)]
fn wait_for_source_window(
    expected_game_binary: &Path,
    timeout: Duration,
) -> Result<windows_sys::Win32::Foundation::HWND, String> {
    log_launcher_event("handoff: waiting for CS:GO to create its game window");
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(window) = verified_source_window(expected_game_binary)? {
            return Ok(window);
        }
        if running_game_process_ids(expected_game_binary)?.is_empty() {
            log_launcher_event("handoff: CS:GO exited before creating its game window");
            return Err(
                "CS:GO exited before creating its game window. If Steam still shows the game as Running, fully exit and restart Steam, then click Open Launcher again."
                    .to_string(),
            );
        }
        if Instant::now() >= deadline {
            log_launcher_event("handoff: timed out waiting for the CS:GO game window");
            return Err(
                "CS:GO did not create its game window within two minutes. Open App 4465480 from Steam, then try again."
                    .to_string(),
            );
        }
        thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(windows)]
fn wait_for_game_process(expected_game_binary: &Path, timeout: Duration) -> Result<(), String> {
    log_launcher_event("handoff: waiting for Steam to start the CS:GO process");
    let deadline = Instant::now() + timeout;
    loop {
        let processes = running_game_process_ids(expected_game_binary)?;
        if !processes.is_empty() {
            log_launcher_event(&format!(
                "handoff: CS:GO process started with PID(s) {}",
                processes
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            return Ok(());
        }
        if Instant::now() >= deadline {
            log_launcher_event("handoff: Steam did not start a CS:GO process");
            return Err(
                "Steam did not start CS:GO within 15 seconds. If Steam shows the game as Running, fully exit and restart Steam, then click Open Launcher again."
                    .to_string(),
            );
        }
        thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(windows)]
fn send_source_command(
    window: windows_sys::Win32::Foundation::HWND,
    request: &ConnectRequest,
) -> Result<(), String> {
    use windows_sys::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SMTO_ABORTIFHUNG, SendMessageTimeoutA, WM_COPYDATA,
    };

    let mut command = source_connect_command(request).into_bytes();
    command.push(0);
    let copy_data = COPYDATASTRUCT {
        dwData: 0,
        cbData: command.len() as u32,
        lpData: command.as_mut_ptr().cast(),
    };
    let mut accepted = 0_usize;
    let delivered = unsafe {
        SendMessageTimeoutA(
            window,
            WM_COPYDATA,
            0,
            (&copy_data as *const COPYDATASTRUCT) as isize,
            SMTO_ABORTIFHUNG,
            SOURCE_COMMAND_TIMEOUT_MS,
            &mut accepted,
        )
    };
    if delivered == 0 {
        log_launcher_event("handoff: the CS:GO window did not respond to WM_COPYDATA");
        return Err(
            "The running CS:GO window stopped responding to the connection handoff. Close CS:GO, then click Open Launcher again."
                .to_string(),
        );
    }
    if accepted == 0 {
        log_launcher_event("handoff: CS:GO rejected the WM_COPYDATA command");
        return Err("CS:GO rejected the post-start connection handoff.".to_string());
    }
    log_launcher_event("handoff: CS:GO accepted the connection command");
    Ok(())
}

#[cfg(windows)]
fn source_connect_handoff(
    steam: &Path,
    app_id: &str,
    game_root: &Path,
    expected_game_binary: &Path,
    request: &ConnectRequest,
) -> Result<(), String> {
    if let Some(window) = verified_source_window(expected_game_binary)? {
        log_launcher_event("handoff: found an existing CS:GO game window");
        if request.inventory_url.is_some() {
            wait_for_gc_inventory(game_root, expected_game_binary)?;
        }
        return send_source_command(window, request);
    }

    let running_processes = running_game_process_ids(expected_game_binary)?;
    if !running_processes.is_empty() {
        let process_ids = running_processes
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        log_launcher_event(&format!(
            "handoff: blocked by headless CS:GO process PID(s) {process_ids}"
        ));
        return Err(format!(
            "CS:GO is still running without a game window (PID {process_ids}). End that process from Steam or Task Manager, then click Open Launcher again."
        ));
    }

    log_launcher_event(&format!("handoff: asking Steam to launch App {app_id}"));
    Command::new(steam)
        .args(steam_start_arguments(app_id))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not launch Steam: {error}"))?;
    wait_for_game_process(expected_game_binary, SOURCE_PROCESS_WAIT)?;
    let window = wait_for_source_window(expected_game_binary, SOURCE_WINDOW_WAIT)?;
    log_launcher_event("handoff: CS:GO window found; waiting for engine startup");
    thread::sleep(SOURCE_COLD_START_SETTLE);
    let window = verified_source_window(expected_game_binary)?.unwrap_or(window);
    if request.inventory_url.is_some() {
        wait_for_gc_inventory(game_root, expected_game_binary)?;
    }
    send_source_command(window, request)
}

#[cfg(not(windows))]
fn source_connect_handoff(
    _steam: &Path,
    _app_id: &str,
    _game_root: &Path,
    _expected_game_binary: &Path,
    _request: &ConnectRequest,
) -> Result<(), String> {
    Err("Launching CS:GO is only supported on Windows.".to_string())
}

#[cfg(windows)]
fn reg_add(key: &str, name: Option<&str>, value: &str) -> Result<(), String> {
    let mut args = vec!["ADD", key];
    match name {
        Some(name) => args.extend(["/v", name]),
        None => args.push("/ve"),
    }
    args.extend(["/t", "REG_SZ", "/d", value, "/f"]);
    let status = Command::new("reg.exe")
        .args(args)
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("Windows refused the per-user protocol registration.".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn register_protocol(executable: &Path) -> Result<(), String> {
    let command = format!("\"{}\" protocol \"%1\"", executable.display());
    reg_add(r"HKCU\Software\Classes\b2g", None, "URL:B2G Launcher")?;
    reg_add(r"HKCU\Software\Classes\b2g", Some("URL Protocol"), "")?;
    reg_add(
        r"HKCU\Software\Classes\b2g\shell\open\command",
        None,
        &command,
    )
}

pub fn install_protocol(dry_run: bool) -> Result<(), String> {
    if dry_run {
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        return Err("Protocol registration is only supported on Windows.".to_string());
    }
    #[cfg(windows)]
    {
        let executable = env::current_exe()
            .map_err(|error| error.to_string())?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        register_protocol(&executable)
    }
}

fn normalize_hex(value: &str, expected: usize, label: &str) -> Result<String, String> {
    let normalized: String = value
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    if normalized.len() != expected
        || !normalized
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(format!(
            "{label} must contain {expected} hexadecimal characters."
        ));
    }
    Ok(normalized)
}

fn normalize_oid(value: &str, label: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 160
        || normalized.starts_with('.')
        || normalized.ends_with('.')
        || normalized.split('.').any(|part| {
            part.is_empty() || !part.chars().all(|character| character.is_ascii_digit())
        })
    {
        return Err(format!(
            "{label} must be a dotted-decimal object identifier."
        ));
    }
    Ok(normalized.to_string())
}

fn normalize_artifact_signing_identity_eku(value: &str, label: &str) -> Result<String, String> {
    let normalized = normalize_oid(value, label)?;
    if !normalized.starts_with(ARTIFACT_SIGNING_EKU_PREFIX)
        || normalized == ARTIFACT_SIGNING_PUBLIC_TRUST_EKU
    {
        return Err(format!(
            "{label} must be the profile-specific Azure Artifact Signing durable identity EKU."
        ));
    }
    Ok(normalized)
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not open update payload: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash update payload: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:X}", digest.finalize()))
}

#[cfg(windows)]
fn authenticode(path: &Path) -> Result<(String, Vec<String>), String> {
    let script = "$s=Get-AuthenticodeSignature -LiteralPath $env:AFTERTICK_VERIFY_FILE; $e=if($s.SignerCertificate){$s.SignerCertificate.Extensions | Where-Object {$_.Oid.Value -eq '2.5.29.37'} | Select-Object -First 1}else{$null}; $o=if($e){@($e.EnhancedKeyUsages | ForEach-Object {$_.Value}) -join ','}else{''}; [Console]::Out.Write($s.Status.ToString()+'|'+$o)";
    let mut failures = Vec::new();
    for shell in ["pwsh.exe", "powershell.exe"] {
        let output = match Command::new(shell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ])
            .env("AFTERTICK_VERIFY_FILE", path)
            .output()
        {
            Ok(output) => output,
            Err(error) => {
                failures.push(format!("{shell}: {error}"));
                continue;
            }
        };
        if !output.status.success() {
            failures.push(format!(
                "{shell} ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
            continue;
        }
        let value = String::from_utf8(output.stdout)
            .map_err(|_| "Signature verifier returned invalid text.".to_string())?;
        let (status, eku_text) = value.trim().split_once('|').unwrap_or((value.trim(), ""));
        let ekus = eku_text
            .split(',')
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect();
        return Ok((status.to_string(), ekus));
    }
    Err(format!(
        "Windows signature verification failed to run: {}",
        failures.join("; ")
    ))
}

#[cfg(not(windows))]
fn authenticode(_path: &Path) -> Result<(String, Vec<String>), String> {
    Err("Authenticode verification is only available on Windows.".to_string())
}

pub fn verify_update_file(
    path: &Path,
    expected_sha256: &str,
    expected_publisher_identity_eku: &str,
) -> Result<(), String> {
    let expected_hash = normalize_hex(expected_sha256, 64, "SHA-256")?;
    let actual_hash = sha256_file(path)?;
    if actual_hash != expected_hash {
        return Err("Update payload SHA-256 does not match the manifest.".to_string());
    }
    let expected_publisher_identity_eku =
        normalize_oid(expected_publisher_identity_eku, "Publisher identity EKU")?;
    let (status, signer_ekus) = authenticode(path)?;
    if status != "Valid" {
        return Err(format!("Update payload Authenticode status is {status}."));
    }
    if !signer_ekus
        .iter()
        .any(|eku| eku == &expected_publisher_identity_eku)
    {
        return Err("Update payload was signed by an unexpected publisher.".to_string());
    }
    Ok(())
}

fn validate_https(value: &str, label: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| format!("{label} is not a valid URL."))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(format!("{label} must be a credential-free HTTPS URL."));
    }
    Ok(url)
}

fn update_agent() -> Agent {
    Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(HTTPS_TIMEOUT))
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .new_agent()
}

fn api_origin(value: &str) -> Result<Url, String> {
    let url = validate_https(value, "B2G API origin")?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("B2G API origin must not contain a path, query, or fragment.".to_string());
    }
    Ok(url)
}

fn api_endpoint(origin: &str, path: &str) -> Result<String, String> {
    api_origin(origin)?
        .join(path.trim_start_matches('/'))
        .map(|url| url.to_string())
        .map_err(|_| "Could not construct the B2G API endpoint.".to_string())
}

fn post_api_json<T: Serialize, R: serde::de::DeserializeOwned>(
    endpoint: &str,
    body: &T,
    access_token: Option<&str>,
    label: &str,
) -> Result<R, String> {
    validate_https(endpoint, "B2G API endpoint")?;
    let body = serde_json::to_string(body)
        .map_err(|error| format!("Could not encode {label}: {error}"))?;
    let request = update_agent()
        .post(endpoint)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json");
    let request = if let Some(token) = access_token {
        request.header("Authorization", &format!("Bearer {token}"))
    } else {
        request
    };
    let mut response = request.send(body).map_err(|error| match error {
        ureq::Error::StatusCode(status) => format!("{label} returned HTTP {status}."),
        _ => format!("{label} failed: {error}"),
    })?;
    let mut response_body = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_API_RESPONSE_BYTES + 1)
        .read_to_end(&mut response_body)
        .map_err(|error| format!("Could not read {label}: {error}"))?;
    if response_body.len() as u64 > MAX_API_RESPONSE_BYTES {
        return Err(format!("{label} response exceeds 1 MiB."));
    }
    serde_json::from_slice(&response_body)
        .map_err(|error| format!("{label} response is invalid: {error}"))
}

fn get_api_json<R: serde::de::DeserializeOwned>(
    endpoint: &str,
    access_token: &str,
    label: &str,
) -> Result<R, String> {
    validate_https(endpoint, "B2G API endpoint")?;
    let mut response = update_agent()
        .get(endpoint)
        .header("Accept", "application/json")
        .header("Authorization", &format!("Bearer {access_token}"))
        .call()
        .map_err(|error| match error {
            ureq::Error::StatusCode(status) => format!("{label} returned HTTP {status}."),
            _ => format!("{label} failed: {error}"),
        })?;
    let mut response_body = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_API_RESPONSE_BYTES + 1)
        .read_to_end(&mut response_body)
        .map_err(|error| format!("Could not read {label}: {error}"))?;
    if response_body.len() as u64 > MAX_API_RESPONSE_BYTES {
        return Err(format!("{label} response exceeds 1 MiB."));
    }
    serde_json::from_slice(&response_body)
        .map_err(|error| format!("{label} response is invalid: {error}"))
}

fn valid_secret(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_user_code(value: &str) -> bool {
    value.len() == 9
        && value.as_bytes().get(4) == Some(&b'-')
        && value.bytes().enumerate().all(|(index, byte)| {
            index == 4 || matches!(byte, b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' | b'2'..=b'9')
        })
}

fn validate_device_authorization(
    authorization: &LauncherDeviceAuthorization,
    expected_origin: &str,
) -> Result<(), String> {
    if authorization.version != 1
        || !valid_secret(&authorization.device_code)
        || !valid_user_code(&authorization.user_code)
        || authorization.expires_at.is_empty()
        || authorization.expires_at.len() > 64
        || !(1..=30).contains(&authorization.interval_seconds)
    {
        return Err("B2G returned an invalid launcher authorization.".to_string());
    }
    let verification = validate_https(&authorization.verification_url, "Verification URL")?;
    if verification.origin() != api_origin(expected_origin)?.origin() {
        return Err("B2G returned a verification URL for an unexpected site.".to_string());
    }
    Ok(())
}

fn validate_launcher_credential(credential: &LauncherCredential) -> Result<(), String> {
    if credential.version != 1
        || !valid_secret(&credential.access_token)
        || credential.expires_at.is_empty()
        || credential.expires_at.len() > 64
    {
        return Err("Stored B2G launcher credentials are invalid.".to_string());
    }
    api_origin(&credential.api_origin)?;
    Ok(())
}

#[cfg(windows)]
fn open_verification_url(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    validate_https(url, "Verification URL")?;
    let operation = "open\0".encode_utf16().collect::<Vec<_>>();
    let target = url
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as usize <= 32 {
        return Err(format!(
            "Windows could not open the B2G authorization page (code {}). Open it manually: {url}",
            result as usize
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_verification_url(_url: &str) -> Result<(), String> {
    Ok(())
}

const LAUNCHER_CREDENTIAL_TARGET: &str = "B2G/Launcher/Primary";

#[cfg(windows)]
fn store_launcher_credential(credential: &LauncherCredential) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredWriteW,
    };

    validate_launcher_credential(credential)?;
    let mut blob = serde_json::to_vec(credential)
        .map_err(|error| format!("Could not encode launcher credentials: {error}"))?;
    if blob.len() > 512 {
        return Err(
            "Launcher credentials exceed the Windows Credential Manager limit.".to_string(),
        );
    }
    let mut target = LAUNCHER_CREDENTIAL_TARGET
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut username = "B2G Player"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let native = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..Default::default()
    };
    if unsafe { CredWriteW(&native, 0) } == 0 {
        return Err(format!(
            "Could not save launcher authorization in Windows Credential Manager: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn store_launcher_credential(_credential: &LauncherCredential) -> Result<(), String> {
    Err("Secure launcher credential storage is only supported on Windows.".to_string())
}

#[cfg(windows)]
fn read_launcher_credential() -> Result<Option<LauncherCredential>, String> {
    use windows_sys::Win32::Security::Credentials::{
        CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
    };

    let target = LAUNCHER_CREDENTIAL_TARGET
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut native: *mut CREDENTIALW = std::ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut native) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(1168) {
            return Ok(None);
        }
        return Err(format!(
            "Could not read launcher authorization from Windows Credential Manager: {error}"
        ));
    }
    if native.is_null() {
        return Err("Windows Credential Manager returned an empty credential.".to_string());
    }
    let bytes = unsafe {
        let credential = &*native;
        if credential.CredentialBlob.is_null() || credential.CredentialBlobSize == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            )
            .to_vec()
        }
    };
    unsafe { CredFree(native.cast()) };
    let credential: LauncherCredential = serde_json::from_slice(&bytes)
        .map_err(|_| "Stored B2G launcher credentials are unreadable.".to_string())?;
    validate_launcher_credential(&credential)?;
    Ok(Some(credential))
}

#[cfg(not(windows))]
fn read_launcher_credential() -> Result<Option<LauncherCredential>, String> {
    Err("Secure launcher credential storage is only supported on Windows.".to_string())
}

#[cfg(windows)]
fn delete_launcher_credential() -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{CRED_TYPE_GENERIC, CredDeleteW};

    let target = LAUNCHER_CREDENTIAL_TARGET
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(1168) {
            return Err(format!(
                "Could not remove launcher authorization from Windows Credential Manager: {error}"
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn delete_launcher_credential() -> Result<(), String> {
    Err("Secure launcher credential storage is only supported on Windows.".to_string())
}

fn launcher_device_name() -> String {
    let computer = env::var("COMPUTERNAME")
        .ok()
        .filter(|value| !value.is_empty() && value.len() <= 48)
        .unwrap_or_else(|| "Windows PC".to_string());
    format!("B2G Launcher on {computer}")
}

pub fn authorize_launcher(origin: &str) -> Result<LauncherPairingResult, String> {
    authorize_launcher_with_progress(origin, |code, url| {
        println!("\nAuthorization code: {code}\nApproval page: {url}\n");
    }, &std::sync::Mutex::new(false))
}

pub(crate) fn authorize_launcher_with_progress(
    origin: &str,
    on_code: impl Fn(&str, &str),
    cancelled: &std::sync::Mutex<bool>,
) -> Result<LauncherPairingResult, String> {
    let check_cancelled = || -> Result<(), String> {
        if *cancelled.lock().map_err(|_| "Authorization cancelled.")? { Err("Authorization cancelled.".into()) } else { Ok(()) }
    };
    api_origin(origin)?;
    log_launcher_event("account: requesting a one-time authorization code");
    let authorization: LauncherDeviceAuthorization = post_api_json(
        &api_endpoint(origin, "/api/launcher/v1/device/authorizations")?,
        &serde_json::json!({}),
        None,
        "Launcher authorization request",
    )?;
    validate_device_authorization(&authorization, origin)?;
    log_launcher_event(&format!(
        "account: approve code {} in your browser",
        authorization.user_code
    ));
    check_cancelled()?;
    on_code(&authorization.user_code, &authorization.verification_url);
    if let Err(error) = open_verification_url(&authorization.verification_url) {
        log_launcher_event(&format!(
            "account: browser did not open automatically: {error}"
        ));
    }
    log_launcher_event("account: waiting for browser approval");

    let started = Instant::now();
    let maximum_wait = Duration::from_secs(11 * 60);
    loop {
        check_cancelled()?;
        if started.elapsed() >= maximum_wait {
            return Err("Launcher authorization expired. Start authorization again.".to_string());
        }
        let exchange: LauncherTokenExchange = post_api_json(
            &api_endpoint(origin, "/api/launcher/v1/device/token")?,
            &serde_json::json!({
                "deviceCode": authorization.device_code,
                "deviceName": launcher_device_name()
            }),
            None,
            "Launcher authorization check",
        )?;
        match exchange {
            LauncherTokenExchange::Pending {
                retry_after_seconds,
                version,
            } => {
                if version != 1 {
                    return Err("B2G returned an unsupported authorization response.".to_string());
                }
                for _ in 0..retry_after_seconds.clamp(1, 30) * 4 {
                    check_cancelled()?;
                    thread::sleep(Duration::from_millis(250));
                }
            }
            LauncherTokenExchange::Authorized {
                access_token,
                expires_at,
                version,
            } => {
                let credential = LauncherCredential {
                    version,
                    api_origin: origin.to_string(),
                    access_token,
                    expires_at: expires_at.clone(),
                };
                validate_launcher_credential(&credential)?;
                // Closing/cancelling the UI and storing a successful credential
                // share the same lock, so an abandoned flow cannot sign in later.
                let guard = cancelled.lock().map_err(|_| "Authorization cancelled.")?;
                if *guard { return Err("Authorization cancelled.".into()); }
                store_launcher_credential(&credential)?;
                log_launcher_event("account: authorization saved in Windows Credential Manager");
                return Ok(LauncherPairingResult {
                    user_code: authorization.user_code,
                    expires_at,
                });
            }
        }
    }
}

pub fn launcher_bootstrap() -> Result<serde_json::Value, String> {
    let credential = read_launcher_credential()?
        .ok_or_else(|| "This launcher is not connected to a B2G account.".to_string())?;
    get_api_json(
        &api_endpoint(&credential.api_origin, "/api/launcher/v1/bootstrap")?,
        &credential.access_token,
        "B2G account status",
    )
}

pub fn revoke_launcher() -> Result<String, String> {
    let credential = read_launcher_credential()?
        .ok_or_else(|| "This launcher is not connected to a B2G account.".to_string())?;
    let remote_result = post_api_json::<_, serde_json::Value>(
        &api_endpoint(&credential.api_origin, "/api/launcher/v1/device/revoke")?,
        &serde_json::json!({}),
        Some(&credential.access_token),
        "Launcher authorization removal",
    );
    delete_launcher_credential()?;
    match remote_result {
        Ok(_) => Ok("B2G account authorization was removed from this PC.".to_string()),
        Err(error) => Err(format!(
            "Local B2G authorization was removed, but the server could not be reached to revoke it: {error}"
        )),
    }
}

fn fetch_manifest(manifest_url: &str) -> Result<UpdateManifest, String> {
    validate_https(manifest_url, "Update manifest URL")?;
    let mut response = update_agent()
        .get(manifest_url)
        .call()
        .map_err(|error| format!("Could not fetch update manifest: {error}"))?;
    let mut body = String::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_string(&mut body)
        .map_err(|error| format!("Could not read update manifest: {error}"))?;
    if body.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Update manifest exceeds 64 KiB.".to_string());
    }
    let manifest: UpdateManifest =
        serde_json::from_str(&body).map_err(|error| format!("Invalid update manifest: {error}"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn version_parts(value: &str) -> Result<Vec<u64>, String> {
    let normalized = value.strip_prefix('v').unwrap_or(value);
    let core = normalized
        .split_once('-')
        .map(|pair| pair.0)
        .unwrap_or(normalized);
    let parts: Result<Vec<_>, _> = core.split('.').map(str::parse::<u64>).collect();
    let parts =
        parts.map_err(|_| "Update version is not numeric semantic version text.".to_string())?;
    if parts.len() != 3 {
        return Err("Update version must contain major.minor.patch.".to_string());
    }
    Ok(parts)
}

fn is_newer(candidate: &str, current: &str) -> Result<bool, String> {
    Ok(version_parts(candidate)? > version_parts(current)?)
}

fn validate_manifest(manifest: &UpdateManifest) -> Result<(), String> {
    version_parts(&manifest.version)?;
    validate_https(&manifest.url, "Update payload URL")?;
    normalize_hex(&manifest.sha256, 64, "SHA-256")?;
    normalize_artifact_signing_identity_eku(
        &manifest.publisher_identity_eku,
        "Publisher identity EKU",
    )?;
    Ok(())
}

fn pinned_publisher_identity() -> Result<String, String> {
    let value = UPDATE_PUBLISHER_IDENTITY_EKU.ok_or_else(||
        "Automatic updates are disabled for this unsigned launcher. Download the next release manually from the official B2G release page.".to_string()
    )?;
    normalize_artifact_signing_identity_eku(value, "Pinned publisher identity EKU")
}

pub fn install(dry_run: bool) -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    {
        let _ = dry_run;
        return Err("Launcher installation is only supported on Windows.".to_string());
    }
    #[cfg(windows)]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "LOCALAPPDATA is unavailable.".to_string())?;
        let directory = local.join("B2G").join("bin");
        let target = directory.join("b2g-launcher.exe");
        if dry_run {
            return Ok(target);
        }
        let current = env::current_exe()
            .map_err(|error| format!("Could not resolve launcher executable: {error}"))?;
        // Public-trust builds pin and verify their Authenticode publisher before
        // installing. Unsigned alpha builds deliberately have no publisher pin;
        // they can install per user but cannot use the automatic update path.
        if UPDATE_PUBLISHER_IDENTITY_EKU.is_some() {
            let publisher_identity = pinned_publisher_identity()?;
            let (status, signer_ekus) = authenticode(&current)?;
            if status != "Valid" {
                return Err(format!(
                    "Only a valid Authenticode-signed launcher can install this public-trust build; status is {status}."
                ));
            }
            if !signer_ekus.iter().any(|eku| eku == &publisher_identity) {
                return Err(
                    "Launcher signer does not match its pinned release publisher.".to_string(),
                );
            }
        }
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not create per-user launcher directory: {error}"))?;
        // Windows launchers and shortcuts can return the same executable with
        // different path casing or an extended-length path prefix. Copying the
        // running file onto itself fails with ERROR_SHARING_VIOLATION.
        if !same_windows_path(&current, &target) {
            fs::copy(&current, &target)
                .map_err(|error| format!("Could not install launcher: {error}"))?;
        }
        register_protocol(&target)?;
        if let Err(error)=setup::install_shortcut(&target){
            log_launcher_event(&format!("install: Start menu shortcut unavailable: {error}"));
        }
        Ok(target)
    }
}

pub fn check_for_update(manifest_url: &str) -> Result<UpdateCheck, String> {
    let pinned = pinned_publisher_identity()?;
    let manifest = fetch_manifest(manifest_url)?;
    if manifest.publisher_identity_eku != pinned {
        return Err(
            "Manifest publisher does not match the publisher pinned into this launcher."
                .to_string(),
        );
    }
    Ok(UpdateCheck {
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        available_version: manifest.version.clone(),
        update_available: is_newer(&manifest.version, env!("CARGO_PKG_VERSION"))?,
        publisher_pinned: true,
    })
}

fn update_directory() -> Result<PathBuf, String> {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let path = base.join("B2G").join("updates");
    fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create update staging directory: {error}"))?;
    Ok(path)
}

pub fn stage_update(manifest_url: &str) -> Result<StagedUpdate, String> {
    let publisher_identity = pinned_publisher_identity()?;
    let manifest = fetch_manifest(manifest_url)?;
    if manifest.publisher_identity_eku != publisher_identity {
        return Err("Manifest publisher does not match this launcher.".to_string());
    }
    if !is_newer(&manifest.version, env!("CARGO_PKG_VERSION"))? {
        return Err("No newer launcher version is available.".to_string());
    }
    let target = env::current_exe()
        .map_err(|error| format!("Could not resolve current launcher: {error}"))?;
    let staged =
        update_directory()?.join(format!("b2g-launcher-{}.exe.download", manifest.version));
    let mut response = update_agent()
        .get(&manifest.url)
        .call()
        .map_err(|error| format!("Could not download update: {error}"))?;
    let mut reader = response.body_mut().as_reader().take(MAX_UPDATE_BYTES + 1);
    let mut file = File::create(&staged)
        .map_err(|error| format!("Could not create update payload: {error}"))?;
    let bytes = std::io::copy(&mut reader, &mut file)
        .map_err(|error| format!("Could not write update payload: {error}"))?;
    file.flush()
        .map_err(|error| format!("Could not flush update payload: {error}"))?;
    if bytes > MAX_UPDATE_BYTES {
        let _ = fs::remove_file(&staged);
        return Err("Update payload exceeds 128 MiB.".to_string());
    }
    if let Err(error) = verify_update_file(&staged, &manifest.sha256, &publisher_identity) {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    Ok(StagedUpdate {
        version: manifest.version,
        staged_path: staged,
        target_path: target,
        sha256: manifest.sha256,
        publisher_identity_eku: publisher_identity,
    })
}

pub fn launch_update_helper(update: &StagedUpdate) -> Result<(), String> {
    let current = env::current_exe().map_err(|error| error.to_string())?;
    let helper = update_directory()?.join(format!("b2g-updater-{}.exe", std::process::id()));
    fs::copy(&current, &helper)
        .map_err(|error| format!("Could not create updater helper: {error}"))?;
    Command::new(helper)
        .args([
            "apply-update",
            "--parent-pid",
            &std::process::id().to_string(),
            "--staged",
            &update.staged_path.display().to_string(),
            "--target",
            &update.target_path.display().to_string(),
            "--sha256",
            &update.sha256,
            "--publisher-identity-eku",
            &update.publisher_identity_eku,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start updater helper: {error}"))?;
    Ok(())
}

fn process_exists(pid: u32) -> bool {
    #[cfg(windows)]
    {
        Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
}

pub fn apply_staged_update(
    parent_pid: u32,
    staged: &Path,
    target: &Path,
    hash: &str,
    publisher_identity_eku: &str,
) -> Result<(), String> {
    for _ in 0..150 {
        if !process_exists(parent_pid) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if process_exists(parent_pid) {
        return Err("Launcher did not exit before update timeout.".to_string());
    }
    verify_update_file(staged, hash, publisher_identity_eku)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let backup = target.with_extension(format!("exe.backup-{nonce}"));
    fs::rename(target, &backup)
        .map_err(|error| format!("Could not preserve current launcher: {error}"))?;
    if let Err(error) = fs::rename(staged, target) {
        let _ = fs::rename(&backup, target);
        return Err(format!("Could not install verified update: {error}"));
    }
    match Command::new(target).arg("doctor").spawn() {
        Ok(_) => {
            let _ = fs::remove_file(backup);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(target);
            let _ = fs::rename(&backup, target);
            Err(format!(
                "Updated launcher could not start; rollback restored the prior version: {error}"
            ))
        }
    }
}

#[cfg(test)]
mod profile_icon_tests {
    use super::*;

    #[test]
    fn stored_profile_icon_accepts_only_offered_values() {
        assert_eq!(
            stored_profile_icon(r#"{"profileIcon":"monogram-gold"}"#).as_deref(),
            Some("monogram-gold")
        );
        // An unknown, malformed or absent value falls back to the shipped default.
        for text in [
            r#"{"profileIcon":"agent-portrait"}"#,
            r#"{"profileIcon":42}"#,
            r#"{"other":"value"}"#,
            "not json",
            "",
        ] {
            assert_eq!(stored_profile_icon(text), None, "{text}");
        }
        assert!(set_profile_icon("agent-portrait").is_err());
    }

    #[test]
    fn every_offered_profile_icon_names_itself() {
        for value in PROFILE_ICONS {
            assert_ne!(profile_icon_label(value), "");
        }
        assert_eq!(profile_icon_label(PROFILE_ICONS[0]), "Portrait");
        assert_eq!(profile_icon_label("rank"), "Rank emblem");
        // An unknown value still names the default rather than showing nothing.
        assert_eq!(profile_icon_label("removed-option"), "Portrait");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_only_credential_free_https_api_endpoints() {
        assert_eq!(
            api_endpoint(DEFAULT_API_ORIGIN, "/api/launcher/v1/bootstrap").unwrap(),
            "https://play.back2go.net/api/launcher/v1/bootstrap"
        );
        assert!(api_endpoint("http://play.back2go.net", "/api").is_err());
        assert!(api_endpoint("https://person:secret@play.back2go.net", "/api").is_err());
        assert!(api_endpoint("https://play.back2go.net/prefix", "/api").is_err());
        assert!(api_endpoint("https://play.back2go.net/?next=evil", "/api").is_err());
    }

    #[test]
    fn validates_device_authorization_site_and_secret_shapes() {
        let authorization = LauncherDeviceAuthorization {
            version: 1,
            device_code: "ab".repeat(32),
            user_code: "B2G4-PLAY".to_string(),
            verification_url: "https://play.back2go.net/?launcher_code=B2G4-PLAY".to_string(),
            expires_at: "2026-09-02T19:00:00.000Z".to_string(),
            interval_seconds: 3,
        };
        validate_device_authorization(&authorization, DEFAULT_API_ORIGIN).unwrap();

        let mut external = authorization.clone();
        external.verification_url = "https://attacker.example/?launcher_code=B2G4-PLAY".to_string();
        assert!(validate_device_authorization(&external, DEFAULT_API_ORIGIN).is_err());

        let mut malformed = authorization;
        malformed.device_code = "AA".repeat(32);
        assert!(validate_device_authorization(&malformed, DEFAULT_API_ORIGIN).is_err());
    }

    #[test]
    fn parses_pending_and_authorized_device_exchanges_without_exposing_tokens() {
        let pending: LauncherTokenExchange =
            serde_json::from_str(r#"{"version":1,"status":"pending","retryAfterSeconds":3}"#)
                .unwrap();
        assert_eq!(
            pending,
            LauncherTokenExchange::Pending {
                retry_after_seconds: 3,
                version: 1
            }
        );

        let token = "01".repeat(32);
        let authorized: LauncherTokenExchange = serde_json::from_str(&format!(
            r#"{{"version":1,"status":"authorized","accessToken":"{token}","expiresAt":"2026-12-01T00:00:00.000Z"}}"#
        ))
        .unwrap();
        let LauncherTokenExchange::Authorized { access_token, .. } = authorized else {
            panic!("expected authorized exchange")
        };
        assert_eq!(access_token, token);
    }

    #[test]
    fn rejects_untrusted_stored_launcher_credentials() {
        let credential = LauncherCredential {
            version: 1,
            api_origin: DEFAULT_API_ORIGIN.to_string(),
            access_token: "ab".repeat(32),
            expires_at: "2026-12-01T00:00:00.000Z".to_string(),
        };
        validate_launcher_credential(&credential).unwrap();

        let mut insecure = credential;
        insecure.api_origin = "http://play.back2go.net".to_string();
        assert!(validate_launcher_credential(&insecure).is_err());
    }

    #[test]
    fn parses_vdf_values_and_escaped_library_paths() {
        let value = "\"installdir\"  \"Counter-Strike Global Offensive\"\n\"BetaKey\" \"csgo_legacy\"\n\"path\" \"D:\\\\Games\"";
        assert_eq!(
            vdf_value(value, "installdir").as_deref(),
            Some("Counter-Strike Global Offensive")
        );
        assert_eq!(vdf_value(value, "BetaKey").as_deref(), Some("csgo_legacy"));
        assert_eq!(vdf_value(value, "path").as_deref(), Some(r"D:\Games"));
    }

    #[cfg(windows)]
    #[test]
    fn installed_executable_is_the_same_file_despite_windows_path_spelling() {
        let executable = env::current_exe().unwrap();
        let upper_case = PathBuf::from(executable.to_string_lossy().to_ascii_uppercase());
        let canonical = fs::canonicalize(&executable).unwrap();
        assert!(same_windows_path(&executable, &upper_case));
        assert!(same_windows_path(&executable, &canonical));
        assert!(!same_windows_path(
            &executable,
            &executable.with_file_name("different-b2g-launcher.exe")
        ));
    }

    fn steam_fixture(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("b2g-steam-{label}-{nonce}"));
        fs::create_dir_all(root.join("steamapps").join("common")).unwrap();
        fs::write(root.join("steam.exe"), b"fixture").unwrap();
        root
    }

    fn install_fixture(
        root: &Path,
        app_id: &str,
        directory: &str,
        beta_key: Option<&str>,
    ) -> PathBuf {
        let beta = beta_key
            .map(|value| format!("\n\t\"BetaKey\"\t\t\"{value}\""))
            .unwrap_or_default();
        fs::write(
            root.join("steamapps")
                .join(format!("appmanifest_{app_id}.acf")),
            format!(
                "\"AppState\"\n{{\n\t\"appid\"\t\t\"{app_id}\"\n\t\"installdir\"\t\t\"{directory}\"{beta}\n}}\n"
            ),
        )
        .unwrap();
        let game_root = root.join("steamapps").join("common").join(directory);
        fs::create_dir_all(game_root.join("csgo")).unwrap();
        fs::write(game_root.join("csgo.exe"), b"fixture").unwrap();
        fs::write(
            game_root.join("csgo").join("steam.inf"),
            "ClientVersion=1575\nServerVersion=1575\nPatchVersion=1.38.8.1\n",
        )
        .unwrap();
        game_root
    }

    #[test]
    fn prefers_valve_standalone_csgo_over_app_730() {
        let root = steam_fixture("standalone");
        install_fixture(&root, STANDALONE_APP_ID, "csgo legacy", None);
        install_fixture(
            &root,
            LEGACY_BETA_APP_ID,
            "Counter-Strike Global Offensive",
            None,
        );

        let report = discover_from_roots(std::slice::from_ref(&root));
        assert_eq!(report.app_id.as_deref(), Some(STANDALONE_APP_ID));
        assert_eq!(report.install_kind.as_deref(), Some("standalone"));
        assert!(report.legacy_ready);
        assert!(report.inventory_access_ready);
        assert_eq!(report.current_client_version.as_deref(), Some("1575"));
        assert!(report.blocking_reason.is_none());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn falls_back_to_app_730_csgo_legacy() {
        let root = steam_fixture("app730");
        let game_root = install_fixture(
            &root,
            LEGACY_BETA_APP_ID,
            "Counter-Strike Global Offensive",
            Some("csgo_legacy"),
        );
        fs::create_dir_all(game_root.join("game").join("csgo")).unwrap();
        fs::write(
            game_root.join("game").join("csgo").join("steam.inf"),
            "ClientVersion=2000899\nServerVersion=2000899\n",
        )
        .unwrap();

        let report = discover_from_roots(std::slice::from_ref(&root));
        assert_eq!(report.app_id.as_deref(), Some(LEGACY_BETA_APP_ID));
        assert_eq!(report.install_kind.as_deref(), Some("app730-legacy"));
        assert!(report.legacy_ready);
        assert!(!report.inventory_access_ready);
        assert_eq!(report.current_client_version.as_deref(), Some("2000899"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cs2_alone_does_not_report_a_legacy_repair_or_csgo_download_progress() {
        let root = steam_fixture("cs2-first-run");
        let game = install_fixture(&root, LEGACY_BETA_APP_ID, "Counter-Strike Global Offensive", Some("public"));
        fs::remove_file(game.join("csgo.exe")).unwrap();
        let manifest = root.join("steamapps/appmanifest_730.acf");
        let contents = fs::read_to_string(&manifest).unwrap();
        fs::write(&manifest, format!("{contents}\n\"BytesDownloaded\" \"100\"\n\"BytesToDownload\" \"100\"\n")).unwrap();
        let report = discover_from_roots(std::slice::from_ref(&root));
        assert!(!report.legacy_ready);
        assert!(report.blocking_reason.as_ref().unwrap().contains("Choose Install"));
        assert!(!report.blocking_reason.as_ref().unwrap().contains("verify App 730"));
        let status = setup::status_from_report(report);
        assert!(status.steam_available);
        assert_eq!((status.ready, status.downloaded, status.total), (false, 0, 0));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn starts_selected_steam_app_without_an_early_connect_command() {
        let request = ConnectRequest {
            server: "203.0.113.10:27115".to_string(),
            password: "aftertickPassword123".to_string(),
            inventory_url: None,
            inventory_token: None,
        };
        assert_eq!(
            steam_start_arguments(STANDALONE_APP_ID),
            vec![
                "-applaunch",
                STANDALONE_APP_ID,
                "-novid",
                "-condebug",
                "-conclearlog"
            ]
        );
        assert_eq!(
            source_connect_command(&request),
            "password aftertickPassword123;connect 203.0.113.10:27115;"
        );
    }

    #[test]
    fn renders_rootless_owned_inventory_keyvalues_for_the_local_gc() {
        let bundle = OwnedInventoryBundle {
            version: 1,
            inventory_version: None,
            match_id: "fac870d4-eb25-4d99-b228-db4961b1d540".to_string(),
            expires_at: "2026-09-03T01:08:40.537Z".to_string(),
            schema_sha256: "510e09b68a01d88edba2342972960025fd6484aaaa58365fcf47d8513de79623"
                .to_string(),
            players: Vec::new(),
        };

        let policy = render_owned_inventory_bundle(&bundle);
        assert!(policy.starts_with("\"format_version\" \"1\"\n"));
        assert!(!policy.contains("\"b2g_owned_manifest\""));
        assert!(policy.ends_with("\"players\"\n{\n}\n"));
    }

    #[test]
    fn accepts_team_specific_weapons_that_share_a_loadout_slot() {
        let item = |asset_id: &str, weapon_key: &str, definition_index: u32| {
            serde_json::json!({
                "assetId": asset_id,
                "source": "b2g",
                "itemKind": "cosmetic",
                "definitionIndex": definition_index,
                "weaponKey": weapon_key,
                "inventoryPosition": 1,
                "paintIndex": 302,
                "paintWear": 0.02,
                "paintSeed": 1,
                "quality": 4,
                "rarity": 4,
                "origin": 24,
                "killEaterScoreType": null,
                "killEaterValue": null,
                "customName": null,
                "sprayKitId": null,
                "sprayTintId": null,
                "spraysRemaining": null,
                "stickers": [],
                "loadoutSlot": 15,
                "equipped": true
            })
        };
        let bundle: OwnedInventoryBundle = serde_json::from_value(serde_json::json!({
            "version": 1,
            "matchId": "fac870d4-eb25-4d99-b228-db4961b1d540",
            "expiresAt": "2026-09-05T06:00:00.000Z",
            "schemaSha256": "510e09b68a01d88edba2342972960025fd6484aaaa58365fcf47d8513de79623",
            "players": [{
                "playerId": "f22214d3-15e3-4ad3-97ae-e70682f18ac5",
                "steamId": "76561198000000077",
                "items": [
                    item("8000000000000000001", "ak47", 7),
                    item("8000000000000000002", "m4a4", 16)
                ]
            }]
        }))
        .unwrap();

        assert_eq!(valid_owned_inventory_bundle(&bundle), Ok(()));
    }

    #[test]
    fn service_medals_use_the_shared_display_slot() {
        let mut bundle = session_inventory_fixture();
        bundle.players[0].items.truncate(1);
        let medal = &mut bundle.players[0].items[0];
        medal.item_kind = "cosmetic".to_string();
        medal.definition_index = 1331;
        medal.weapon_key = "service_medal".to_string();
        medal.loadout_slot = 55;
        medal.equipped = true;
        let policy = render_owned_inventory_bundle(&bundle);
        assert!(policy.contains("\"0\" \"55\""));
        assert!(!policy.contains("\"2\" \"55\""));
        assert!(!policy.contains("\"3\" \"55\""));
    }

    #[test]
    fn ownership_generation_survives_launcher_policy_without_precision_loss() {
        let mut bundle = session_inventory_fixture();
        for value in ["0", "2", "9223372036854775807"] {
            bundle.players[0].items[0].ownership_generation = Some(value.to_string());
            assert_eq!(valid_owned_inventory_bundle(&bundle), Ok(()));
            assert!(render_owned_inventory_bundle(&bundle).contains(&format!("\"ownership_generation\" \"{value}\"")));
        }
        for value in ["-1", "02", "+2", "9223372036854775808", ""] {
            bundle.players[0].items[0].ownership_generation = Some(value.to_string());
            assert!(valid_owned_inventory_bundle(&bundle).is_err());
        }
    }

    fn session_inventory_fixture() -> OwnedInventoryBundle {
        let item = |id: &str, kind: &str, definition: u32| {
            serde_json::json!({
                "assetId": id, "source": "b2g", "itemKind": kind,
                "definitionIndex": definition, "weaponKey": "case_test",
                "inventoryPosition": 1, "paintIndex": null, "paintWear": null,
                "paintSeed": null, "quality": 4, "rarity": 1, "origin": 24,
                "killEaterScoreType": null, "killEaterValue": null,
                "customName": null, "stickers": [], "loadoutSlot": 0, "equipped": false
            })
        };
        serde_json::from_value(serde_json::json!({
            "version": 1, "inventoryVersion": 20,
            "matchId": "00000000-0000-0000-0000-000000000000",
            "expiresAt": "2026-09-05T23:00:00.000Z",
            "schemaSha256": "510e09b68a01d88edba2342972960025fd6484aaaa58365fcf47d8513de79623",
            "players": [{
                "playerId": "f22214d3-15e3-4ad3-97ae-e70682f18ac5",
                "steamId": "76561198000000077",
                "items": [
                    item("8000000000000000997", "case", 4288),
                    item("8000000000000000998", "key", 1343),
                    item("8000000000000000999", "cosmetic", 7)
                ]
            }]
        }))
        .unwrap()
    }

    #[test]
    fn server_handoff_preserves_full_client_inventory_without_expanding_server_scope() {
        let session = session_inventory_fixture();
        let mut match_bundle = session.clone();
        match_bundle.match_id = "fac870d4-eb25-4d99-b228-db4961b1d540".into();
        match_bundle.players[0]
            .items
            .retain(|item| item.item_kind == "cosmetic");
        let selected = connection_inventory(&match_bundle, Some(&session)).unwrap();
        assert_eq!(selected, &session);
        let rendered = render_owned_inventory_bundle(selected);
        assert!(rendered.contains("8000000000000000997"));
        assert!(rendered.contains("8000000000000000998"));
        assert_eq!(match_bundle.players[0].items.len(), 1);
        assert_eq!(
            connection_inventory(&match_bundle, None).unwrap(),
            &match_bundle
        );
    }

    #[test]
    fn server_handoff_rejects_another_accounts_inventory_or_schema() {
        let session = session_inventory_fixture();
        let mut other = session.clone();
        other.players[0].steam_id = "76561198000000001".into();
        assert!(connection_inventory(&session, Some(&other)).is_err());
        other = session.clone();
        other.players[0].player_id = "11111111-2222-3333-4444-555555555555".into();
        assert!(connection_inventory(&session, Some(&other)).is_err());
        other = session.clone();
        other.schema_sha256 = "a".repeat(64);
        assert!(connection_inventory(&session, Some(&other)).is_err());
        other = session.clone();
        other.players.clear();
        assert!(connection_inventory(&session, Some(&other)).is_err());
    }

    #[test]
    fn server_handoff_preserves_new_rewards_and_acknowledged_items_separately() {
        let mut session = session_inventory_fixture();
        session.players[0].items[2].inventory_position = (1 << 30) | 5;
        session.players[0].items[2].origin = 8;
        let mut old_reward = session.players[0].items[2].clone();
        old_reward.asset_id = "8000000000000001000".into();
        old_reward.inventory_position = 130;
        session.players[0].items.push(old_reward);
        let mut match_bundle = session.clone();
        match_bundle.players[0]
            .items
            .retain(|item| item.item_kind == "cosmetic");
        // A stale match snapshot must not undo a real acknowledgement or hide
        // a newer reward. Only the freshly fetched account inventory is used.
        match_bundle.players[0].items[0].inventory_position = 1;
        match_bundle.players[0].items[1].inventory_position = (1 << 30) | 5;
        let selected = connection_inventory(&match_bundle, Some(&session)).unwrap();
        assert_eq!(selected.players[0].items[2].inventory_position, 1073741829);
        assert_eq!(selected.players[0].items[3].inventory_position, 130);
        let rendered = render_owned_inventory_bundle(selected);
        assert!(rendered.contains("\"inventory\" \"1073741829\""));
        assert!(rendered.contains("\"inventory\" \"130\""));
    }

    #[test]
    fn launcher_log_messages_are_single_line_and_bounded() {
        let message = format!(
            "started\r\nwith\ta control {} and {} trailing chars",
            '\u{7}',
            "x".repeat(5_000)
        );
        let sanitized = single_line_log_message(&message);

        assert!(!sanitized.contains(['\r', '\n', '\t', '\u{7}']));
        assert!(sanitized.contains("started  with a control ?"));
        assert_eq!(sanitized.chars().count(), 4_096);
    }

    #[test]
    fn recognizes_owned_inventory_gc_success_and_failure() {
        assert_eq!(
            gc_inventory_status(
                "B2G local GC initialized (owned_only=1, dedicated=0)\n\
                 B2G loaded 2 exact owned items for 76561198000000077\n\
                 B2G published 2 exact owned items to client SOCache\n"
            ),
            Some(Ok(2))
        );
        assert_eq!(
            gc_inventory_status(
                "B2G owned inventory unavailable for 76561198000000077: manifest not found\n"
            ),
            Some(Err(
                "The in-game inventory GC rejected the owned-item manifest: manifest not found."
                    .to_string()
            ))
        );
        assert_eq!(gc_inventory_status("ClientGC spawned\n"), None);
        assert_eq!(
            gc_inventory_status(
                "B2G loaded 2 exact owned items for 76561198000000077\nClientGC spawned\n"
            ),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn finds_a_running_process_by_its_verified_executable_path() {
        let executable = env::current_exe().unwrap();
        let process_ids = running_game_process_ids(&executable).unwrap();

        assert!(windows_process_is_active(std::process::id()).unwrap());
        assert!(process_ids.contains(&std::process::id()));
    }

    #[cfg(windows)]
    #[test]
    fn does_not_treat_an_exited_process_with_a_retained_handle_as_active() {
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/c", "exit", "0"])
            .spawn()
            .unwrap();
        let process_id = child.id();
        assert!(child.wait().unwrap().success());

        assert!(!windows_process_is_active(process_id).unwrap());
    }

    #[test]
    fn inventory_failures_keep_the_server_explanation_and_bound_untrusted_text() {
        assert_eq!(inventory_response_error(409, br#"{"error":"Link a valid Steam account before starting CS:GO."}"#),
            "Could not load inventory: Link a valid Steam account before starting CS:GO.");
        assert!(inventory_response_error(502, b"<html>proxy failure</html>").contains("HTTP 502"));
        assert!(inventory_response_error(409, br#"{"error":""}"#).contains("HTTP 409"));
        let body = serde_json::json!({"error": "界".repeat(600)}).to_string();
        assert_eq!(inventory_response_error(409, body.as_bytes()).matches('界').count(), 512);
    }

    #[test]
    fn installs_and_restores_the_owned_gc_without_losing_valve_launcher() {
        let root = env::temp_dir().join(format!("b2g-gc-install-{}", now_unix()));
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("csgo_gc")).unwrap();
        fs::write(root.join("bin").join("launcher.dll"), b"fixture launcher").unwrap();
        let original = b"MZ fixture Valve executable";
        fs::write(root.join("csgo.exe"), original).unwrap();
        let wrapped_config = format!(
            "\"config\"\n{{\n{}\n}}\n",
            GC_CONFIG
                .lines()
                .map(|line| format!("    {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert_eq!(
            sha256_bytes(wrapped_config.as_bytes()),
            GC_CONFIG_WRAPPED_V1_SHA256
        );
        fs::write(root.join("csgo_gc").join("config.txt"), wrapped_config).unwrap();

        assert!(ensure_gc_for_root(&root).unwrap());
        assert!(!ensure_gc_for_root(&root).unwrap());
        assert!(file_has_sha256(
            &root.join("csgo.exe"),
            GC_CLIENT_WRAPPER_SHA256
        ));
        assert_eq!(
            fs::read(root.join("csgo.exe.b2g-original")).unwrap(),
            original
        );
        assert!(file_has_sha256(
            &root.join("csgo_gc").join("csgo_gc.dll"),
            GC_LIBRARY_SHA256
        ));
        assert!(
            fs::read_to_string(root.join("csgo_gc").join("config.txt"))
                .unwrap()
                .starts_with("\"log_output\" \"2\"\n")
        );
        assert!(
            !root
                .join("csgo_gc")
                .join("config.txt.b2g-original")
                .exists()
        );

        assert!(
            restore_managed_file(
                &root.join("csgo.exe"),
                GC_CLIENT_WRAPPER_SHA256,
                Some(&root.join("csgo.exe.b2g-original")),
                &[],
            )
            .unwrap()
        );
        assert_eq!(fs::read(root.join("csgo.exe")).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn uninstall_does_not_restore_b2g_files_mistaken_for_originals() {
        let root = env::temp_dir().join(format!("b2g-uninstall-managed-backup-{}", now_unix()));
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("bin/launcher.dll"), b"fixture launcher").unwrap();
        let original = b"MZ fixture Valve executable";
        fs::write(root.join("csgo.exe"), original).unwrap();
        ensure_gc_for_root(&root).unwrap();
        // Older installers could save B2G itself as the supposed original.
        fs::write(root.join("csgo_gc/csgo_gc.dll.b2g-original"), GC_LIBRARY).unwrap();
        fs::write(root.join("csgo_gc/config.txt.b2g-original"), GC_CONFIG).unwrap();
        uninstall_gc_for_root(&root, true).unwrap();
        assert!(root.join("csgo_gc/csgo_gc.dll.b2g-original").exists());
        uninstall_gc_for_root(&root, false).unwrap();
        for name in ["csgo_gc.dll", "csgo_gc.dll.b2g-original", "config.txt", "config.txt.b2g-original"] {
            assert!(!root.join("csgo_gc").join(name).exists(), "{name} remained");
        }
        assert_eq!(fs::read(root.join("csgo.exe")).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_upgrades_skip_own_backups_but_preserve_unknown_originals() {
        let root = env::temp_dir().join(format!("b2g-managed-upgrade-{}", now_unix()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("managed.dll");
        let backup = root.join("managed.dll.b2g-original");
        let old = b"previous managed version";
        let current = b"current managed version";
        let old_hash = sha256_bytes(old);
        let current_hash = sha256_bytes(current);
        let previous = &[old_hash.as_str()];

        fs::write(&path, old).unwrap();
        install_managed_file(&path, current, &current_hash, Some(&backup), false, previous).unwrap();
        assert!(!backup.exists(), "upgrades must not invent an original");
        for target_present in [true, false] {
            fs::write(&backup, old).unwrap();
            if !target_present { fs::remove_file(&path).unwrap(); }
            restore_managed_file(&path, &current_hash, Some(&backup), previous).unwrap();
            assert!(!path.exists());
            assert!(!backup.exists());
            fs::write(&path, current).unwrap();
        }

        let original = b"unrelated pre-existing GC";
        fs::write(&path, original).unwrap();
        install_managed_file(&path, current, &current_hash, Some(&backup), false, previous).unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original);
        // An existing real original must survive any number of managed upgrades.
        fs::write(&path, old).unwrap();
        install_managed_file(&path, current, &current_hash, Some(&backup), false, previous).unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original);
        restore_managed_file(&path, &current_hash, Some(&backup), previous).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn uninstall_preflights_every_file_before_mutation_and_restores_originals() {
        let root = env::temp_dir().join(format!("b2g-uninstall-{}", now_unix()));
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("bin/launcher.dll"), b"fixture launcher").unwrap();
        let original = b"MZ fixture original";
        fs::write(root.join("csgo.exe"), original).unwrap();
        ensure_gc_for_root(&root).unwrap();
        let library = root.join("csgo_gc/csgo_gc.dll");
        fs::remove_file(root.join("csgo.exe.b2g-original")).unwrap();
        for dry_run in [true, false] {
            assert!(
                uninstall_gc_for_root(&root, dry_run)
                    .unwrap_err()
                    .contains("backup is missing")
            );
            assert!(file_has_sha256(&library, GC_LIBRARY_SHA256));
        }
        fs::write(root.join("csgo.exe.b2g-original"), original).unwrap();
        fs::write(root.join("csgo_gc/config.txt"), b"custom config").unwrap();
        assert!(
            uninstall_gc_for_root(&root, false)
                .unwrap_err()
                .contains("unrecognized file")
        );
        assert!(file_has_sha256(&library, GC_LIBRARY_SHA256));
        fs::write(root.join("csgo_gc/config.txt"), GC_CONFIG).unwrap();
        let preserved=[
            "csgo/cfg/config.cfg", "csgo/replays/test.dem", "csgo/steam.inf",
            "appmanifest_4465480.acf", "csgo_gc/b2g_loadout_76561198000000077.txt",
            "csgo_gc/saved_item_shuffles.txt",
        ];
        for path in preserved {
            fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            fs::write(root.join(path),format!("preserved {path}")).unwrap();
        }
        fs::write(root.join("csgo_gc/b2g_owned_manifest.txt"),b"transient inventory").unwrap();
        uninstall_gc_for_root(&root, true).unwrap();
        assert!(file_has_sha256(&library, GC_LIBRARY_SHA256));
        // A failed prior update can leave the target missing while its backup survives.
        fs::remove_file(root.join("csgo.exe")).unwrap();
        uninstall_gc_for_root(&root, false).unwrap();
        assert_eq!(fs::read(root.join("csgo.exe")).unwrap(), original);
        assert!(!library.exists());
        assert!(!root.join("csgo_gc/b2g_owned_manifest.txt").exists());
        assert!(ensure_gc_for_root(&root).unwrap());
        assert!(file_has_sha256(&library,GC_LIBRARY_SHA256));
        assert_eq!(fs::read(root.join("csgo.exe.b2g-original")).unwrap(),original);
        for path in preserved {assert_eq!(fs::read_to_string(root.join(path)).unwrap(),format!("preserved {path}"));}
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn refuses_live_gc_repair_before_changing_any_game_files() {
        use std::os::windows::process::CommandExt;
        struct FixtureProcess(std::process::Child);
        impl Drop for FixtureProcess {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root = env::temp_dir().join(format!("b2g-live-repair-{}", now_unix()));
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("csgo_gc")).unwrap();
        fs::write(root.join("bin/launcher.dll"), b"fixture launcher").unwrap();
        fs::write(root.join("csgo_gc/csgo_gc.dll"), b"old GC").unwrap();
        // A copied command interpreter holds stdin open. No Steam/game process
        // is launched; this exercises the actual executable-path process guard.
        fs::copy(env::var_os("COMSPEC").unwrap(), root.join("csgo.exe")).unwrap();
        let original_hash = sha256_file(&root.join("csgo.exe")).unwrap();
        let process = FixtureProcess(
            Command::new(root.join("csgo.exe"))
                .args(["/d", "/q"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
                .unwrap(),
        );
        assert!(
            require_game_stopped(&root)
                .unwrap_err()
                .contains("Close CS:GO")
        );
        assert!(
            ensure_gc_for_root(&root)
                .unwrap_err()
                .contains("Close CS:GO")
        );
        assert_eq!(
            fs::read(root.join("csgo_gc/csgo_gc.dll")).unwrap(),
            b"old GC"
        );
        assert!(!root.join("csgo_gc/config.txt").exists());
        assert!(!root.join("csgo.exe.b2g-original").exists());
        assert_eq!(sha256_file(&root.join("csgo.exe")).unwrap(), original_hash);
        drop(process);
        require_game_stopped(&root).unwrap();
        assert!(ensure_gc_for_root(&root).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validation_only_connect_defaults_to_standalone_without_steam() {
        let report = empty_doctor_report();
        assert_eq!(selected_app_id(&report, true).unwrap(), STANDALONE_APP_ID);
        assert!(selected_app_id(&report, false).is_err());
    }

    #[test]
    fn synchronizes_legacy_inventory_metadata_with_backup_and_no_credentials() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("b2g-inventory-sync-{nonce}"));
        let legacy_dir = root.join("csgo");
        let current_dir = root.join("game").join("csgo");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::create_dir_all(&current_dir).unwrap();
        fs::write(
            current_dir.join("steam.inf"),
            "ClientVersion=2000899\nServerVersion=2000899\n",
        )
        .unwrap();
        fs::write(
            legacy_dir.join("steam.inf"),
            "ClientVersion=1575\nServerVersion=1575\nProductName=csgo\n",
        )
        .unwrap();

        assert!(
            sync_inventory_for_root(&root, true)
                .unwrap()
                .starts_with("Would synchronize")
        );
        assert!(
            fs::read_to_string(legacy_dir.join("steam.inf"))
                .unwrap()
                .contains("ClientVersion=1575")
        );
        assert!(
            sync_inventory_for_root(&root, false)
                .unwrap()
                .contains("2000899")
        );
        let patched = fs::read_to_string(legacy_dir.join("steam.inf")).unwrap();
        assert!(patched.contains("ClientVersion=2000899"));
        assert!(patched.contains("ServerVersion=1575"));
        assert!(legacy_dir.join("steam.inf.b2g-backup").is_file());
        assert!(
            sync_inventory_for_root(&root, false)
                .unwrap()
                .contains("is ready")
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_server_endpoints_without_shell_text() {
        assert!(validate_server("127.0.0.1:27015").is_ok());
        assert!(validate_server("game.back2go.net:27015").is_ok());
        assert!(validate_server("[::1]:27015").is_ok());
        assert!(validate_server("server;calc.exe:27015").is_err());
        assert!(validate_server("server:0").is_err());
    }

    #[test]
    fn measures_source_udp_latency_and_packet_loss() {
        let server = UdpSocket::bind("127.0.0.1:0").unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let address = server.local_addr().unwrap();
        let responder = thread::spawn(move || {
            let mut request = [0_u8; 128];
            for _ in 0..3 {
                let (_, peer) = server.recv_from(&mut request).unwrap();
                server
                    .send_to(&[0xff, 0xff, 0xff, 0xff, 0x49], peer)
                    .unwrap();
            }
        });

        let report = probe_latency(&address.to_string(), 3, Duration::from_millis(200)).unwrap();
        responder.join().unwrap();
        assert_eq!(report.requested_samples, 3);
        assert_eq!(report.successful_samples, 3);
        assert_eq!(report.packet_loss_percent, 0.0);
        assert!(report.median_ms.is_some());
        assert!(report.p95_ms.is_some());
    }

    #[test]
    fn parses_only_expected_deep_links_and_credentials() {
        let value = ConnectRequest::from_deep_link(
            "b2g://connect?server=127.0.0.1%3A27015&password=abcDEF_1234567890-xyz",
        )
        .unwrap();
        assert_eq!(value.server, "127.0.0.1:27015");
        assert_eq!(value.password, "abcDEF_1234567890-xyz");
        let inventory_link = format!(
            "b2g://connect?server=127.0.0.1%3A27015&password=abcDEF_1234567890-xyz&inventory=https%3A%2F%2Fplay.example.test%2Fapi%2Flauncher%2Fv1%2Finventory%2F74c5fd31-5a64-499f-8180-a6976ba3bd53&inventory_token={}",
            "ab".repeat(32)
        );
        let inventory = ConnectRequest::from_deep_link(&inventory_link).unwrap();
        assert_eq!(
            inventory.inventory_url.as_deref(),
            Some(
                "https://play.example.test/api/launcher/v1/inventory/74c5fd31-5a64-499f-8180-a6976ba3bd53"
            )
        );
        assert_eq!(
            inventory.inventory_token.as_deref(),
            Some("ab".repeat(32).as_str())
        );
        assert!(ConnectRequest::from_deep_link(
            "b2g://connect?server=127.0.0.1%3A27015&password=abcDEF_1234567890-xyz&inventory=https%3A%2F%2Fplay.example.test%2Finventory"
        ).is_err());
        assert!(ConnectRequest::from_deep_link(
            &format!("b2g://connect?server=127.0.0.1%3A27015&password=abcDEF_1234567890-xyz&inventory=http%3A%2F%2Fplay.example.test%2Finventory&inventory_token={}", "ab".repeat(32))
        ).is_err());
        assert!(
            ConnectRequest::from_deep_link(
                "https://connect?server=x:1&password=abcDEF_1234567890-xyz"
            )
            .is_err()
        );
    }

    #[test]
    fn parses_bounded_probe_links_without_exposing_unknown_targets() {
        let targets = vec![LatencyProbeEndpoint {
            region: "NA Central".to_string(),
            server: "127.0.0.1:27015".to_string(),
            samples: 5,
        }];
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&targets).unwrap());
        let link = format!(
            "b2g://probe?challenge=00000000-0000-4000-8000-000000000001&token={}&submit=https%3A%2F%2Fplay.example.test%2Fapi%2Flatency%2Fv1%2Freports&targets={encoded}",
            "ab".repeat(32)
        );
        let request = LatencyProbeRequest::from_deep_link(&link).unwrap();
        assert_eq!(request.endpoints, targets);
        assert!(
            handle_protocol(&link, true)
                .unwrap()
                .contains("1 regional probe")
        );
        assert!(
            LatencyProbeRequest::from_deep_link(
                "b2g://probe?challenge=bad&token=bad&submit=http://attacker.test&targets=bad"
            )
            .is_err()
        );
    }

    #[test]
    fn signs_the_same_canonical_latency_report_as_the_api() {
        let submission = LatencyProbeSubmission {
            version: 1,
            challenge_id: "00000000-0000-4000-8000-000000000001".to_string(),
            measurements: vec![LatencyProbeMeasurement {
                region: "NA Central".to_string(),
                server: "127.0.0.1:27015".to_string(),
                requested_samples: 5,
                successful_samples: 4,
                median_ms: Some(20.0),
                p95_ms: Some(25.0),
                packet_loss_percent: 20.0,
            }],
        };
        assert_eq!(
            hmac_sha256_hex(&"ab".repeat(32), &canonical_latency_submission(&submission)).unwrap(),
            "cfcf98b50f89eeed6e853b3b7f7265b6e75309300841190730847f3b1d5387a7"
        );
    }

    #[test]
    fn identifies_public_probe_addresses_conservatively() {
        assert!(public_probe_address("1.1.1.1:27015".parse().unwrap()));
        assert!(public_probe_address(
            "[2606:4700:4700::1111]:27015".parse().unwrap()
        ));
        assert!(!public_probe_address("127.0.0.1:27015".parse().unwrap()));
        assert!(!public_probe_address("10.0.0.1:27015".parse().unwrap()));
        assert!(!public_probe_address("169.254.10.1:27015".parse().unwrap()));
        assert!(!public_probe_address("192.0.2.1:27015".parse().unwrap()));
        assert!(!public_probe_address(
            "[::ffff:127.0.0.1]:27015".parse().unwrap()
        ));
        assert!(!public_probe_address("[fd00::1]:27015".parse().unwrap()));
        assert!(!public_probe_address(
            "[2001:db8::1]:27015".parse().unwrap()
        ));
    }

    #[test]
    fn hashes_files_and_compares_semantic_versions() {
        let path = env::temp_dir().join(format!("b2g-launcher-hash-{}", std::process::id()));
        fs::write(&path, b"aftertick").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "EF4D4011E766A402842A59A9889202C18003BD76477E4764EB93A4016343EB94"
        );
        let _ = fs::remove_file(path);
        assert!(is_newer("0.2.0", "0.1.9").unwrap());
        assert!(!is_newer("0.1.0", "0.1.0").unwrap());
    }

    #[test]
    fn validates_strict_update_manifests() {
        let manifest = UpdateManifest {
            version: "0.2.0".to_string(),
            url: "https://updates.back2go.net/b2g-launcher.exe".to_string(),
            sha256: "A".repeat(64),
            publisher_identity_eku: "1.3.6.1.4.1.311.97.990309390.766961637.194916062.941502583"
                .to_string(),
        };
        assert!(validate_manifest(&manifest).is_ok());
        assert!(
            validate_manifest(&UpdateManifest {
                url: "http://updates.invalid/file".to_string(),
                ..manifest
            })
            .is_err()
        );
        assert!(
            normalize_artifact_signing_identity_eku(
                ARTIFACT_SIGNING_PUBLIC_TRUST_EKU,
                "Publisher identity EKU"
            )
            .is_err()
        );
    }
}

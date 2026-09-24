//! The bundled webview owns presentation. Credentials, consent journals, file
//! changes and the game session stay in Rust behind a fixed command vocabulary.
use crate::trading::{Mutation, PendingMutation, TradingApi};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

#[derive(Clone, Default)]
struct Runtime {
    data: Arc<Mutex<Session>>,
    cancelled: Arc<Mutex<bool>>,
    mutation: Arc<Mutex<()>>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    phase: Phase,
    message: String,
    pairing: bool,
    pair_code: Option<String>,
    pair_url: Option<String>,
    installing: bool,
    preparing: bool,
    install_error: Option<String>,
    revision: u64,
}

#[derive(Clone, Copy, Default, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum Phase {
    #[default]
    Idle,
    Starting,
    Running,
    Failed,
}

impl Runtime {
    fn update(&self, f: impl FnOnce(&mut Session)) {
        if let Ok(mut state) = self.data.lock() {
            f(&mut state);
            state.revision += 1;
        }
    }
    fn snapshot(&self) -> Result<Session, String> {
        self.data
            .lock()
            .map(|s| s.clone())
            .map_err(|_| "Launcher state is unavailable. Reopen B2G.".into())
    }
    fn idle(&self) -> Result<(), String> {
        let s = self.snapshot()?;
        if matches!(s.phase, Phase::Starting | Phase::Running) || game_open()? {
            return Err("Close CS:GO before changing this installation or account.".into());
        }
        if s.preparing || s.installing || s.pairing {
            return Err("Finish or cancel the current setup operation first.".into());
        }
        Ok(())
    }
}

fn game_open() -> Result<bool, String> {
    let report = crate::discover();
    match report.legacy_binary {
        Some(path) => {
            crate::running_game_process_ids(std::path::Path::new(&path)).map(|p| !p.is_empty())
        }
        None => Ok(false),
    }
}

fn text<'a>(args: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    args[key]
        .as_str()
        .filter(|s| s.len() <= max && !s.chars().any(char::is_control))
        .ok_or_else(|| format!("Invalid {key}. Refresh and retry."))
}
fn id<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    let value = text(args, key, 36)?;
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err(format!("Invalid {key}. Refresh and retry."));
    }
    Ok(value)
}
fn query(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs.iter().copied())
        .finish()
}
fn value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}
fn external(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "Invalid link.")?;
    let allowed = parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.port().is_none()
        && matches!(
            parsed.host_str(),
            Some("play.back2go.net" | "steamcommunity.com" | "store.steampowered.com")
        );
    if !allowed {
        return Err("This link cannot be opened by B2G.".into());
    }
    shell_open(url)
}
fn shell_open(target: &str) -> Result<(), String> {
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let result = unsafe {
        windows_sys::Win32::UI::Shell::ShellExecuteW(
            std::ptr::null_mut(),
            wide("open").as_ptr(),
            wide(target).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err("Windows could not open this. Retry from the launcher.".into());
    }
    Ok(())
}

fn status(runtime: &Runtime) -> Result<Value, String> {
    let s = runtime.snapshot()?;
    Ok(
        json!({"session":s,"gameOpen":game_open()?,"installation":crate::setup::status(),
        "paired":crate::read_launcher_credential()?.is_some(),"profileIcon":crate::profile_icon(),
        "debugConsole":crate::console::visible(),"version":env!("CARGO_PKG_VERSION")}),
    )
}

fn start_game(runtime: Runtime) -> Result<Value, String> {
    runtime.idle()?;
    runtime.update(|s| {
        s.phase = Phase::Starting;
        s.message = "Preparing your inventory and starting CS:GO.".into();
    });
    std::thread::spawn(move || {
        let ready = runtime.clone();
        let result = crate::client_session::run_client_session_with_ready(move || {
            ready.update(|s| {
                s.phase = Phase::Running;
                s.message = "CS:GO is running. Matchmaking and inventory are connected.".into();
            })
        });
        runtime.update(|s| match result {
            Ok(message) => {
                s.phase = Phase::Idle;
                s.message = message;
            }
            Err(message) => {
                s.phase = Phase::Failed;
                s.message = message;
            }
        });
    });
    Ok(json!({"started":true}))
}

fn begin_pair(runtime: Runtime) -> Result<Value, String> {
    runtime.idle()?;
    *runtime
        .cancelled
        .lock()
        .map_err(|_| "Sign-in is unavailable.")? = false;
    runtime.update(|s| {
        s.pairing = true;
        s.message.clear();
        s.pair_code = None;
        s.pair_url = None;
    });
    std::thread::spawn(move || {
        let result = crate::authorize_launcher_with_progress(
            crate::DEFAULT_API_ORIGIN,
            |code, url| {
                runtime.update(|s| {
                    s.pair_code = Some(code.into());
                    s.pair_url = Some(url.into());
                });
            },
            &runtime.cancelled,
        );
        runtime.update(|s| {
            s.pairing = false;
            s.pair_code = None;
            s.pair_url = None;
            s.message = result
                .map(|_| "Account connected. Finish your B2G profile to continue.".into())
                .unwrap_or_else(|e| e);
        });
    });
    Ok(json!({"started":true}))
}

fn begin_install(runtime: Runtime) -> Result<Value, String> {
    runtime.idle()?;
    crate::setup::begin_install()?;
    runtime.update(|s| {
        s.installing = true;
        s.install_error = None;
    });
    std::thread::spawn(move || {
        let mut had_steam = crate::setup::status().steam_available;
        loop {
            if !runtime.snapshot().is_ok_and(|s| s.installing) {
                break;
            }
            let current = crate::setup::status();
            if current.ready {
                runtime.update(|s| s.preparing = true);
                let result = crate::repair_game(false);
                runtime.update(|s| {
                    s.preparing = false;
                    s.installing = false;
                    s.install_error = result.err();
                });
                break;
            }
            if !had_steam && current.steam_available {
                if let Err(error) = crate::setup::begin_install() {
                    runtime.update(|s| {
                        s.installing = false;
                        s.install_error = Some(error);
                    });
                    break;
                }
                had_steam = true;
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
    Ok(json!({"started":true}))
}

fn execute(runtime: Runtime, operation: &str, args: Value) -> Result<Value, String> {
    // Serialize writes, including launch/pair start. Never hold this lock during
    // a long game session; its persisted state excludes duplicate starts.
    let is_read = matches!(
        operation,
        "status"
            | "bootstrap"
            | "account"
            | "inventory"
            | "matches"
            | "match"
            | "friends"
            | "profile"
            | "trade_overview"
            | "trade_players"
            | "trade_inventory"
            | "trade_offers"
            | "trade_offer"
            | "trade_events"
            | "trade_pending"
    );
    let _write = if is_read {
        None
    } else {
        Some(
            runtime
                .mutation
                .try_lock()
                .map_err(|_| "Another action is finishing. Retry in a moment.")?,
        )
    };
    match operation {
        "status" => return status(&runtime),
        "bootstrap" => return crate::launcher_bootstrap(),
        "play" => return start_game(runtime.clone()),
        "pair" => return begin_pair(runtime.clone()),
        "cancel_pair" => {
            *runtime
                .cancelled
                .lock()
                .map_err(|_| "Sign-in is unavailable.")? = true;
            return Ok(Value::Null);
        }
        "install" => return begin_install(runtime.clone()),
        "stop_install" => {
            if runtime.snapshot()?.preparing {
                return Err("B2G is finishing game files. Wait a moment.".into());
            }
            runtime.update(|s| s.installing = false);
            return Ok(Value::Null);
        }
        "open_steam" => {
            shell_open("steam://open/main")?;
            return Ok(Value::Null);
        }
        "open_link" => {
            external(text(&args, "url", 2048)?)?;
            return Ok(Value::Null);
        }
        "profile_icon" => {
            crate::set_profile_icon(text(&args, "icon", 32)?)?;
            return Ok(Value::Null);
        }
        "debug_console" => {
            crate::console::set_visible(args["visible"].as_bool().ok_or("Invalid preference.")?)?;
            return Ok(Value::Null);
        }
        "open_log" => {
            let path = crate::launcher_log_path().ok_or("Log folder is unavailable.")?;
            shell_open(&path.to_string_lossy())?;
            return Ok(Value::Null);
        }
        "open_demos" => {
            let root = std::env::var_os("LOCALAPPDATA")
                .map(std::path::PathBuf::from)
                .ok_or("Demo folder is unavailable.")?
                .join("B2G/demos");
            std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            shell_open(&root.to_string_lossy())?;
            return Ok(Value::Null);
        }
        "diagnostics" => return value(crate::game_diagnostics()?),
        "repair" => {
            runtime.idle()?;
            return value(crate::repair_game(false)?);
        }
        "uninstall" => {
            runtime.idle()?;
            crate::uninstall::begin()?;
            return Ok(json!({"close":true}));
        }
        "logout" => {
            runtime.idle()?;
            let warning = crate::revoke_launcher().err();
            if crate::read_launcher_credential()?.is_some() {
                return Err(warning.unwrap_or("Could not disconnect. Retry.".into()));
            }
            return Ok(json!({"warning":warning}));
        }
        _ => {}
    }
    let api = TradingApi::connected().map_err(|e| e.message)?;
    execute_api(api, operation, args)
}

fn execute_api(api: TradingApi, operation: &str, args: Value) -> Result<Value, String> {
    let read = |path: &str| {
        api.launcher_request::<Value>(path, None)
            .map_err(|e| e.message)
    };
    let post = |path: &str, body: &Value| {
        api.launcher_request::<Value>(path, Some(body))
            .map_err(|e| e.message)
    };
    let offset = args["offset"]
        .as_u64()
        .unwrap_or(0)
        .min(100_000)
        .to_string();
    match operation {
        "account" => read("/api/launcher/v1/account"),
        "inventory" => read("/api/launcher/v1/account/inventory"),
        "inventory_refresh" => post("/api/launcher/v1/account/inventory/refresh", &json!({})),
        "settings" => post("/api/launcher/v1/account/settings", &args["settings"]),
        "onboard" => {
            let result = post("/api/launcher/v1/account/onboarding", &args);
            if result.is_err() {
                if let Ok(player) = read("/api/launcher/v1/account") {
                    if player["onboardingRequired"] == false {
                        return Ok(player);
                    }
                }
            }
            result
        }
        "matches" => read(&format!(
            "/api/launcher/v1/matches?limit=12&offset={offset}"
        )),
        "match" => read(&format!("/api/launcher/v1/matches/{}", id(&args, "id")?)),
        "demo" => {
            let id = id(&args, "id")?;
            let detail = read(&format!("/api/launcher/v1/matches/{id}"))?;
            api.download_demo(id, &detail["demo"])
                .map_err(|e| e.message)?;
            Ok(json!({"downloaded":true}))
        }
        "friends" => {
            let folder = text(&args, "folder", 16)?;
            if !matches!(folder, "friends" | "incoming" | "outgoing" | "search") {
                return Err("Unknown friends folder.".into());
            }
            read(&format!(
                "/api/launcher/v1/social/friends?{}",
                query(&[
                    ("folder", folder),
                    ("q", args["query"].as_str().unwrap_or("")),
                    ("offset", &offset)
                ])
            ))
        }
        "profile" => {
            let target = if args["id"] == "me" {
                "me"
            } else {
                id(&args, "id")?
            };
            let mode = if args["mode"] == "deathmatch" {
                "deathmatch"
            } else {
                "competitive"
            };
            read(&format!(
                "/api/launcher/v1/social/players/{target}?mode={mode}&offset={offset}"
            ))
        }
        "friend_action" => {
            let action = text(&args, "action", 16)?;
            let request = id(&args, "requestId")?;
            let result = if action == "add" {
                api.launcher_request::<Value>(
                    "/api/launcher/v1/social/requests",
                    Some(&json!({"playerId":id(&args,"playerId")?,"requestId":request})),
                )
            } else if matches!(action, "accept" | "decline" | "cancel" | "remove") {
                api.launcher_request::<Value>(
                    &format!("/api/launcher/v1/social/requests/{request}"),
                    Some(&json!({"action":action})),
                )
            } else {
                return Err("Unknown friend action.".into());
            };
            match result {
                Err(error)
                    if error
                        .status
                        .is_some_and(|status| (400..500).contains(&status) && status != 408) =>
                {
                    Ok(json!({"rejected":true,"message":error.message}))
                }
                other => other.map_err(|error| error.message),
            }
        }
        "trade_overview" => value(api.overview().map_err(|e| e.message)?),
        "trade_players" => value(
            api.players(text(&args, "query", 80)?)
                .map_err(|e| e.message)?,
        ),
        "trade_inventory" => value(
            api.inventory(
                id(&args, "playerId")?,
                text(&args, "query", 80)?,
                text(&args, "kind", 32)?,
                args["cursor"].as_str(),
            )
            .map_err(|e| e.message)?,
        ),
        "trade_offers" => {
            let folder = text(&args, "folder", 16)?;
            if !matches!(folder, "incoming" | "outgoing" | "history") {
                return Err("Unknown trade folder.".into());
            }
            value(
                api.offers(folder, args["cursor"].as_str())
                    .map_err(|e| e.message)?,
            )
        }
        "trade_offer" => value(api.offer(id(&args, "id")?).map_err(|e| e.message)?),
        "trade_events" => value(
            api.events(id(&args, "id")?, args["after"].as_str().unwrap_or("0"))
                .map_err(|e| e.message)?,
        ),
        "trade_seen" => {
            api.seen(text(&args, "eventId", 32)?)
                .map_err(|e| e.message)?;
            Ok(Value::Null)
        }
        "trade_preferences" => value(
            api.preferences(args["allow"].as_bool().ok_or("Invalid preference.")?)
                .map_err(|e| e.message)?,
        ),
        "trade_pending" => value(api.pending(id(&args, "playerId")?).map_err(|e| e.message)?),
        "trade_mutate" => {
            let player_id = id(&args, "playerId")?;
            let pending = if args["recover"] == true {
                api.pending(player_id)
                    .map_err(|e| e.message)?
                    .ok_or("No trade needs recovery.")?
            } else {
                let mutation: Mutation = serde_json::from_value(args["mutation"].clone())
                    .map_err(|_| "Invalid trade. Review the items again.")?;
                PendingMutation::new(player_id.into(), mutation)?
            };
            value(api.mutate(&pending).map_err(|e| e.message)?)
        }
        _ => Err("This launcher action is unavailable. Update B2G and retry.".into()),
    }
}

#[tauri::command]
async fn launcher_call(
    runtime: tauri::State<'_, Runtime>,
    operation: String,
    args: Value,
) -> Result<Value, String> {
    static CONNECTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !CONNECTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        crate::log_launcher_event(
            "ui: bundled Tauri interface connected to the Rust command bridge",
        );
    }
    let runtime = runtime.inner().clone();
    if args.to_string().len() > 131_072 {
        return Err("This request is too large.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result=execute(runtime, &operation, args);
        if operation=="bootstrap" && result.is_ok() {
            static LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !LOADED.swap(true,std::sync::atomic::Ordering::Relaxed) {
                crate::log_launcher_event("ui: Tauri account bootstrap loaded successfully");
            }
        }
        result
    })
        .await
        .map_err(|_| "The launcher operation stopped unexpectedly.".to_string())?
}

pub fn run_launcher_ui() -> Result<(), String> {
    crate::log_launcher_event("ui: opening the Tauri launcher");
    crate::webview_runtime::ensure()?;
    tauri::Builder::default().manage(Runtime::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window)=app.get_webview_window("main") {
                let _=window.unminimize(); let _=window.show(); let _=window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![launcher_call])
        .on_window_event(|window,event|{
            if let tauri::WindowEvent::CloseRequested{api,..}=event {
                let runtime=window.state::<Runtime>();
                let blocked=runtime.snapshot().is_ok_and(|s|matches!(s.phase,Phase::Starting|Phase::Running)||s.preparing) || runtime.mutation.try_lock().is_err();
                if blocked {api.prevent_close();let _=window.emit("close-blocked","Keep B2G open while CS:GO is running or game files are being prepared. You can minimize it.");}
                else if let Ok(mut cancelled)=runtime.cancelled.lock(){*cancelled=true;}
            }
        })
        .run(tauri::generate_context!()).map_err(|e|format!("B2G could not open its interface: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_state_survives_readers_and_ready_does_not_depend_on_a_webview_event() {
        let runtime = Runtime::default();
        runtime.update(|s| s.phase = Phase::Starting);
        let reader = runtime.clone();
        runtime.update(|s| s.phase = Phase::Running);
        assert_eq!(reader.snapshot().unwrap().phase, Phase::Running);
        assert_eq!(reader.snapshot().unwrap().revision, 2);
        runtime.update(|s| s.phase = Phase::Idle);
        assert_eq!(reader.snapshot().unwrap().phase, Phase::Idle);
    }
    #[test]
    fn identifiers_and_external_links_cannot_become_paths_or_shell_commands() {
        assert!(id(&json!({"id":"../../credentials"}), "id").is_err());
        assert!(external("file:///C:/Windows/system32/cmd.exe").is_err());
        assert!(external("https://play.back2go.net.evil.example/").is_err());
        assert!(external("https://user@play.back2go.net/").is_err());
    }
    #[test]
    fn inventory_bridge_uses_fixed_account_routes_and_keeps_refresh_body_empty() {
        use crate::trading::test_support::{Response, Server};
        let captured = Arc::new(Mutex::new(Vec::new()));
        let requests = captured.clone();
        let server = Server::new(move |request| {
            assert_eq!(request.bearer, "Bearer fixture-inventory-token");
            requests.lock().unwrap().push(request);
            Response::okay(json!({"status":"public","items":[]}))
        });
        for operation in ["inventory", "inventory_refresh"] {
            let result = execute_api(server.api("fixture-inventory-token"), operation, json!({"playerId":"other"})).unwrap();
            assert_eq!(result["status"], "public");
            assert!(!result.to_string().contains("fixture-inventory-token"));
        }
        let requests = captured.lock().unwrap();
        assert_eq!(requests[0].path, "/api/launcher/v1/account/inventory");
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[1].path, "/api/launcher/v1/account/inventory/refresh");
        assert_eq!(requests[1].method, "POST");
        assert_eq!(requests[1].body, json!({}));
    }
    #[test]
    fn desktop_bridge_keeps_credentials_in_rust_and_reports_definite_friend_rejection() {
        use crate::trading::test_support::{Response, Server};
        let captured = Arc::new(Mutex::new(Vec::new()));
        let requests = captured.clone();
        let server = Server::new(move |request| {
            assert_eq!(request.bearer, "Bearer fixture-desktop-token");
            let rejection = request.method == "POST";
            requests.lock().unwrap().push(request);
            if rejection {
                Response {
                    status: 409,
                    ..Response::okay(json!({"message":"This request is no longer pending."}))
                }
            } else {
                Response::okay(json!({"displayName":"Fixture player"}))
            }
        });
        let profile = execute_api(
            server.api("fixture-desktop-token"),
            "profile",
            json!({"id":"me","mode":"deathmatch","offset":5}),
        )
        .unwrap();
        assert_eq!(profile["displayName"], "Fixture player");
        assert!(!profile.to_string().contains("fixture-desktop-token"));
        let result = execute_api(
            server.api("fixture-desktop-token"),
            "friend_action",
            json!({"action":"accept","requestId":"11111111-1111-4111-8111-111111111111"}),
        )
        .unwrap();
        assert_eq!(result["rejected"], true);
        assert!(
            execute_api(
                server.api("fixture-desktop-token"),
                "match",
                json!({"id":"../../account"})
            )
            .is_err()
        );
        let requests = captured.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].path,
            "/api/launcher/v1/social/players/me?mode=deathmatch&offset=5"
        );
        assert_eq!(requests[1].body, json!({"action":"accept"}));
    }
}

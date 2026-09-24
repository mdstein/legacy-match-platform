#![cfg_attr(windows, windows_subsystem = "windows")]

use std::env;
use std::path::PathBuf;
use std::time::Duration;

use b2g_launcher::{
    ConnectRequest, DEFAULT_API_ORIGIN, apply_staged_update, authorize_launcher, check_for_update,
    connect, doctor, game_diagnostics, handle_protocol, install, install_protocol,
    launcher_bootstrap, launcher_log_path, log_launcher_event, probe_latency, repair_game,
    restore_inventory_access, revoke_launcher, run_client_session, run_launcher_ui, stage_update,
    sync_inventory_access, uninstall_game, verify_update_file,
};

#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MessageBoxW,
};

#[cfg(windows)]
fn show_message(title: &str, message: &str, is_error: bool) {
    let title = title
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let message = message
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let icon = if is_error {
        MB_ICONERROR
    } else {
        MB_ICONINFORMATION
    };
    // Windows owns these buffers only for the duration of this synchronous call.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | icon,
        );
    }
}

fn usage() -> &'static str {
    "B2G Launcher\n\n\
     Commands:\n\
       version | --version\n\
       ui\n\
       doctor [--json]\n\
       probe --server <host:port> [--samples <1-10>] [--json]\n\
       connect --server <host:port> --password <one-time-password> [--dry-run]\n\
       protocol <b2g://connect?...> [--dry-run] [--no-error-dialog]\n\
       install [--dry-run]\n\
       install-protocol [--dry-run]\n\
       game-repair [--dry-run]\n\
       game-uninstall [--dry-run]\n\
       diagnostics [--json]\n\
       inventory-sync [--dry-run]\n\
       inventory-restore [--dry-run]\n\
       authorize [--api <https-origin>]\n\
       account-status [--json]\n\
       logout\n\
       play\n\
       check-update --manifest <https-url>\n\
       self-update --manifest <https-url>\n\
       verify-update --file <exe> --sha256 <hex> --publisher-identity-eku <oid>\n\
       apply-update --parent-pid <pid> --staged <exe> --target <exe> --sha256 <hex> --publisher-identity-eku <oid>"
}

fn option(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|arg| arg == name)
        .ok_or_else(|| format!("Missing {name}."))?;
    args.get(index + 1)
        .cloned()
        .ok_or_else(|| format!("Missing value for {name}."))
}

fn parse_connect(args: &[String]) -> Result<ConnectRequest, String> {
    Ok(ConnectRequest {
        server: option(args, "--server")?,
        password: option(args, "--password")?,
        inventory_url: None,
        inventory_token: None,
    })
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        #[cfg(windows)]
        {
            install(false)?;
            return run_launcher_ui();
        }
        #[cfg(not(windows))]
        {
            println!("{}", usage());
            return Ok(());
        }
    };
    match command {
        "ui" => run_launcher_ui()?,
        "doctor" => {
            let report = doctor()?;
            if args.iter().any(|arg| arg == "--json") {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!(
                    "Steam: {}",
                    report.steam_executable.as_deref().unwrap_or("not found")
                );
                println!(
                    "Legacy game: {}",
                    if report.app_installed {
                        format!(
                            "App {} ({})",
                            report.app_id.as_deref().unwrap_or("unknown"),
                            report.install_kind.as_deref().unwrap_or("unknown install")
                        )
                    } else {
                        "missing".to_string()
                    }
                );
                println!(
                    "Branch: {}",
                    report.beta_key.as_deref().unwrap_or_else(|| {
                        if report.install_kind.as_deref() == Some("standalone") {
                            "standalone"
                        } else {
                            "unknown"
                        }
                    })
                );
                println!(
                    "Legacy CS:GO: {}",
                    if report.legacy_ready {
                        "ready"
                    } else {
                        "not ready"
                    }
                );
                println!(
                    "Steam-owned inventory: {}",
                    if report.inventory_access_ready {
                        "ready"
                    } else {
                        "needs sync"
                    }
                );
                if let Some(reason) = &report.blocking_reason {
                    println!("Action: {reason}");
                }
            }
        }
        "probe" => {
            let samples = args
                .iter()
                .position(|arg| arg == "--samples")
                .map(|index| {
                    args.get(index + 1)
                        .ok_or_else(|| "Missing value for --samples.".to_string())?
                        .parse::<u8>()
                        .map_err(|_| "Latency samples must be an integer.".to_string())
                })
                .transpose()?
                .unwrap_or(3);
            let report = probe_latency(
                &option(&args[1..], "--server")?,
                samples,
                Duration::from_millis(750),
            )?;
            if args.iter().any(|arg| arg == "--json") {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!("Server: {}", report.server);
                println!(
                    "Latency: {}",
                    report
                        .median_ms
                        .map(|value| format!("{value:.1} ms median"))
                        .unwrap_or_else(|| "no response".to_string())
                );
                println!("Packet loss: {:.1}%", report.packet_loss_percent);
            }
        }
        "connect" => {
            let result = connect(
                &parse_connect(&args[1..])?,
                args.iter().any(|arg| arg == "--dry-run"),
            )?;
            println!("{}", result);
        }
        "protocol" => {
            let uri = args.get(1).ok_or_else(|| "Missing B2G URI.".to_string())?;
            let result = handle_protocol(uri, args.iter().any(|arg| arg == "--dry-run"))?;
            println!("{}", result);
        }
        "install-protocol" => {
            let dry_run = args.iter().any(|arg| arg == "--dry-run");
            install_protocol(dry_run)?;
            println!(
                "The b2g:// protocol handler {} for this Windows account.",
                if dry_run {
                    "can be registered"
                } else {
                    "is registered"
                }
            );
        }
        "install" => {
            let dry_run = args.iter().any(|arg| arg == "--dry-run");
            let target = install(dry_run)?;
            println!(
                "The launcher {} {}.",
                if dry_run {
                    "would be installed at"
                } else {
                    "is installed at"
                },
                target.display()
            );
        }
        "game-repair" => println!(
            "{}",
            repair_game(args.iter().any(|arg| arg == "--dry-run"))?
        ),
        "game-uninstall" => println!(
            "{}",
            uninstall_game(args.iter().any(|arg| arg == "--dry-run"))?
        ),
        "diagnostics" => {
            let report = game_diagnostics()?;
            if args.iter().any(|arg| arg == "--json") {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!("Game root: {}", report.game_root);
                println!("B2G wrapper: {}", report.gc_wrapper_installed);
                println!("B2G GC library: {}", report.gc_library_installed);
                println!("Valve backup: {}", report.original_launcher_backup);
                println!("Console log: {}", report.console_log);
                println!("GC log: {}", report.gc_log);
                println!("Owned manifest: {}", report.inventory_manifest);
                println!(
                    "Launcher log: {}",
                    report.launcher_log.as_deref().unwrap_or("unavailable")
                );
            }
        }
        "inventory-sync" => println!(
            "{}",
            sync_inventory_access(args.iter().any(|arg| arg == "--dry-run"))?
        ),
        "inventory-restore" => println!(
            "{}",
            restore_inventory_access(args.iter().any(|arg| arg == "--dry-run"))?
        ),
        "authorize" => {
            let api = args
                .iter()
                .position(|arg| arg == "--api")
                .map(|index| {
                    args.get(index + 1)
                        .cloned()
                        .ok_or_else(|| "Missing value for --api.".to_string())
                })
                .transpose()?
                .unwrap_or_else(|| DEFAULT_API_ORIGIN.to_string());
            let result = authorize_launcher(&api)?;
            println!(
                "B2G account connected. Authorization {} is valid until {}.",
                result.user_code, result.expires_at
            );
        }
        "account-status" => {
            let status = launcher_bootstrap()?;
            if args.iter().any(|arg| arg == "--json") {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&status).map_err(|error| error.to_string())?
                );
            } else {
                let player = status.get("player");
                let display_name = player
                    .and_then(|value| value.get("displayName"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Unknown player");
                let rank = player
                    .and_then(|value| value.get("rank"))
                    .and_then(|value| value.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Unranked");
                let queue = status
                    .get("queue")
                    .and_then(|value| value.get("phase"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                println!("Player: {display_name}");
                println!("Competitive rank: {rank}");
                println!("Queue: {queue}");
            }
        }
        "logout" => println!("{}", revoke_launcher()?),
        "play" => println!("{}", run_client_session()?),
        "check-update" => {
            let result = check_for_update(&option(&args[1..], "--manifest")?)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
            );
        }
        "self-update" => {
            let result = stage_update(&option(&args[1..], "--manifest")?)?;
            println!("Update {} verified and staged.", result.version);
            b2g_launcher::launch_update_helper(&result)?;
        }
        "verify-update" => {
            verify_update_file(
                &PathBuf::from(option(&args[1..], "--file")?),
                &option(&args[1..], "--sha256")?,
                &option(&args[1..], "--publisher-identity-eku")?,
            )?;
            println!("Update payload hash and Authenticode publisher identity are valid.");
        }
        "apply-update" => {
            let parent_pid = option(&args[1..], "--parent-pid")?
                .parse::<u32>()
                .map_err(|_| "Invalid parent PID.".to_string())?;
            apply_staged_update(
                parent_pid,
                &PathBuf::from(option(&args[1..], "--staged")?),
                &PathBuf::from(option(&args[1..], "--target")?),
                &option(&args[1..], "--sha256")?,
                &option(&args[1..], "--publisher-identity-eku")?,
            )?;
        }
        "help" | "--help" | "-h" => println!("{}", usage()),
        _ => return Err(format!("Unknown command: {command}\n\n{}", usage())),
    }
    Ok(())
}

fn main() {
    b2g_launcher::initialize_console(env::args().nth(1).as_deref());
    #[cfg(windows)]
    if env::args().nth(1).as_deref()==Some("debug-console") {
        let args:Vec<String>=env::args().skip(2).collect();
        let result=(||{
            let parent=option(&args,"--parent-pid")?.parse::<u32>().map_err(|_|"Invalid parent PID.")?;
            b2g_launcher::run_debug_console(parent,&PathBuf::from(option(&args,"--log")?))
        })();
        if result.is_err(){std::process::exit(1);}
        return;
    }
    // Version inspection must not install, open a window, contact the service,
    // or initialize launcher logs/account state.
    if matches!(
        env::args().nth(1).as_deref(),
        Some("version" | "--version" | "-V")
    ) {
        println!("B2G Launcher {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let command = env::args().nth(1).unwrap_or_else(|| "install".to_string());
    let known_command = matches!(
        command.as_str(),
        "doctor"
            | "ui"
            | "probe"
            | "connect"
            | "protocol"
            | "install"
            | "install-protocol"
            | "game-repair"
            | "game-uninstall"
            | "diagnostics"
            | "inventory-sync"
            | "inventory-restore"
            | "authorize"
            | "account-status"
            | "logout"
            | "play"
            | "check-update"
            | "self-update"
            | "verify-update"
            | "apply-update"
            | "help"
            | "--help"
            | "-h"
    );
    log_launcher_event(&format!(
        "launcher: started version={} command={}",
        env!("CARGO_PKG_VERSION"),
        if known_command {
            command.as_str()
        } else {
            "unknown"
        }
    ));
    if let Err(error) = run() {
        log_launcher_event(&format!("launcher: failed: {error}"));
        #[cfg(windows)]
        if !env::args().any(|arg| arg == "--no-error-dialog")
            && (env::args_os().len() == 1
                || matches!(env::args().nth(1).as_deref(), Some("protocol" | "ui")))
        {
            let log_hint = launcher_log_path()
                .map(|path| format!("\n\nDiagnostic log:\n{}", path.display()))
                .unwrap_or_default();
            show_message(
                "B2G Launcher failed",
                &format!("B2G Launcher could not complete the request.\n\n{error}{log_hint}"),
                true,
            );
        }
        eprintln!("B2G Launcher: {error}");
        std::process::exit(1);
    }
    log_launcher_event("launcher: completed successfully");
}

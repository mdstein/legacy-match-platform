#[cfg(windows)]
use super::client_session::run_client_session_with_ready;
use super::is_newer;
#[cfg(windows)]
use super::{DEFAULT_API_ORIGIN, launcher_bootstrap, log_launcher_event};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReleaseNote {
    version: String,
    date: String,
    changes: Vec<(String, String)>,
}

fn release_history(content: Option<&Value>) -> Vec<ReleaseNote> {
    static BUNDLED: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let bundled = BUNDLED.get_or_init(|| {
        serde_json::from_str(include_str!("../../../packages/contracts/src/release.json"))
            .expect("Bundled release metadata")
    });
    content
        .and_then(|c| c.get("history"))
        .or_else(|| bundled.get("history"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(6)
        .filter_map(|entry| {
            let version = bounded_text(entry.get("version"), "", 24);
            if is_newer(&version, "0.0.0").is_err() {
                return None;
            }
            let changes = entry
                .get("changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(8)
                .filter_map(|change| {
                    let kind = bounded_text(change.get("kind"), "changed", 12);
                    let text = bounded_text(change.get("text"), "", 240);
                    (!text.is_empty()).then(|| {
                        (
                            match kind.as_str() {
                                "added" | "fixed" | "removed" => kind,
                                _ => "changed".into(),
                            },
                            text,
                        )
                    })
                })
                .collect();
            Some(ReleaseNote {
                version,
                date: bounded_text(entry.get("date"), "", 10),
                changes,
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LauncherSnapshot {
    onboarding_required: bool,
    reduced_motion: bool,
    display_name: String,
    region: String,
    rank: String,
    rank_id: u64,
    competitive_wins: u64,
    rating: u64,
    profile_level: u64,
    profile_xp: u64,
    service_drop_count: u64,
    channel: String,
    update_status: String,
    update_download_url: Option<String>,
    changelog_title: String,
    changelog_summary: String,
    news_title: String,
    news_summary: String,
    online_players: u64,
    active_matches: u64,
    queue_phase: String,
    release_history: Vec<ReleaseNote>,
}

fn bounded_text(value: Option<&Value>, fallback: &str, maximum: usize) -> String {
    let sanitized = value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .chars()
                .map(|character| {
                    if character.is_control() {
                        ' '
                    } else {
                        character
                    }
                })
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let bounded = sanitized.chars().take(maximum).collect::<String>();
    if bounded.is_empty() {
        fallback.to_string()
    } else {
        bounded
    }
}

#[cfg(test)]
fn launcher_identity_line(channel: Option<&str>) -> String {
    format!(
        "LAUNCHER v{}  /  PANORAMA  /  {}",
        env!("CARGO_PKG_VERSION"),
        channel.unwrap_or("Founders Playtest").to_ascii_uppercase()
    )
}

fn launcher_update_status(release_version: Option<&str>) -> String {
    let Some(release_version) = release_version.filter(|version| version.len() <= 24) else {
        return "RELEASE UNKNOWN".to_string();
    };
    match is_newer(release_version, env!("CARGO_PKG_VERSION")) {
        Ok(true) => format!("UPDATE AVAILABLE  ·  v{release_version}"),
        Ok(false) if is_newer(env!("CARGO_PKG_VERSION"), release_version) == Ok(true) => {
            format!("PUBLISHED  ·  v{release_version}")
        }
        Ok(false) => format!("CURRENT  ·  v{}", env!("CARGO_PKG_VERSION")),
        Err(_) => "RELEASE UNKNOWN".to_string(),
    }
}

fn snapshot_from_bootstrap(value: &Value) -> Result<LauncherSnapshot, String> {
    let player = value
        .get("player")
        .ok_or_else(|| "B2G returned an incomplete launcher profile.".to_string())?;
    let game_profile = value
        .get("gameProfile")
        .ok_or_else(|| "B2G returned an incomplete in-game profile.".to_string())?;
    let platform = value
        .get("platform")
        .ok_or_else(|| "B2G returned incomplete platform status.".to_string())?;
    let launcher = value.get("launcher");
    let launcher_content = launcher.and_then(|entry| entry.get("content"));
    let changelog = launcher_content.and_then(|entry| entry.get("changelog"));
    let news = launcher_content.and_then(|entry| entry.get("news"));
    let release_version = launcher_content
        .and_then(|entry| entry.get("releaseVersion"))
        .and_then(Value::as_str);
    Ok(LauncherSnapshot {
        onboarding_required: player.get("onboardingRequired").and_then(Value::as_bool).unwrap_or(false),
        reduced_motion: player.get("settings").and_then(|v|v.get("reducedMotion")).and_then(Value::as_bool).unwrap_or(false),
        release_history: release_history(launcher_content),
        display_name: bounded_text(player.get("displayName"), "B2G Player", 48),
        region: bounded_text(player.get("region"), "Unknown region", 32),
        rank: bounded_text(
            player.get("rank").and_then(|rank| rank.get("name")),
            "Unranked",
            40,
        ),
        rating: player
            .get("rank")
            .and_then(|rank| rank.get("rating"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        rank_id: game_profile
            .get("competitiveRankId")
            .and_then(Value::as_u64)
            .filter(|rank| *rank <= 18)
            .unwrap_or(0),
        competitive_wins: game_profile
            .get("competitiveWins")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        profile_level: game_profile
            .get("playerLevel")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 40),
        profile_xp: game_profile
            .get("playerXp")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(999),
        service_drop_count: game_profile
            .get("serviceDropCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(39),
        channel: bounded_text(
            launcher_content.and_then(|entry| entry.get("channel")),
            "Founders Playtest",
            32,
        ),
        update_status: launcher_update_status(release_version),
        update_download_url: release_version
            .filter(|v| v.len() <= 24 && is_newer(v, env!("CARGO_PKG_VERSION")) == Ok(true))
            .map(|v| {
                format!("https://play.back2go.net/downloads/b2g-launcher-v{v}-windows-x86_64.exe")
            }),
        changelog_title: bounded_text(
            changelog.and_then(|entry| entry.get("title")),
            "B2G client session is ready",
            64,
        ),
        changelog_summary: bounded_text(
            changelog.and_then(|entry| entry.get("summary")),
            "Launch once, then use Play inside CS:GO for Competitive or Deathmatch.",
            180,
        ),
        news_title: bounded_text(
            news.and_then(|entry| entry.get("title")),
            "Panorama remains the playtest client",
            64,
        ),
        news_summary: bounded_text(
            news.and_then(|entry| entry.get("summary")),
            "Rank, XP, inventory, matchmaking, and server handoff stay synchronized while the game is open.",
            180,
        ),
        online_players: platform
            .get("onlinePlayers")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        active_matches: platform
            .get("activeMatches")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        queue_phase: bounded_text(
            value.get("queue").and_then(|queue| queue.get("phase")),
            "idle",
            24,
        ),
    })
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::collections::VecDeque;
    use std::mem::size_of;
    use std::ptr;
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use windows_sys::Win32::Foundation::{
        COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM,
    };
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::*;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const UI_EVENT: u32 = WM_APP + 41;
    const REFRESH_TIMER: usize = 1;
    const REFRESH_INTERVAL_MS: u32 = 30_000;
    const WINDOW_WIDTH: i32 = 1_360;
    const WINDOW_HEIGHT: i32 = 800;

    #[derive(Debug)]
    enum UiEvent {
        Setup(SetupEvent),
        Account(AccountResult),
        Friends(FriendsResult),
        Trading(TradeResult),
        TradePolled { epoch:u64, result:TradeResult },
        Refreshed(Result<LauncherSnapshot, String>),
        SnapshotRead { window:u64, result:Result<LauncherSnapshot,String> },
        Paired(Result<String, String>),
        GameReady,
        SessionFinished(Result<String, String>),
    }

    #[derive(Debug, Clone)]
    struct UiState {
        motion: MotionState,
        setup: SetupState,
        tab: LauncherTab,
        account: AccountState,
        friends: FriendsState,
        trading: TradingState,
        snapshot: Option<LauncherSnapshot>,
        paired: bool,
        refreshing: bool,
        pairing: bool,
        playing: bool,
        game_ready: bool,
        status: String,
        refresh_error: Option<String>,
        action_error: Option<String>,
        hovered_button: Option<i32>,
        maximized: bool,
    }

    impl Default for UiState {
        fn default() -> Self {
            Self {
                motion: MotionState::default(),
                setup: SetupState::default(),
                tab: LauncherTab::Play,
                account: AccountState::default(),
                friends: FriendsState::default(),
                trading: TradingState::default(),
                snapshot: None,
                paired: false,
                refreshing: false,
                pairing: false,
                playing: false,
                game_ready: false,
                status: "Checking your B2G account and game service…".to_string(),
                refresh_error: None,
                action_error: None,
                hovered_button: None,
                maximized: false,
            }
        }
    }

    impl UiState {
        fn visible_error(&self) -> Option<&str> {
            self.action_error
                .as_deref()
                .or(self.refresh_error.as_deref())
        }

        fn has_launch_error(&self) -> bool {
            self.paired && self.action_error.is_some()
        }

        fn details_label(&self) -> &'static str {
            if self.has_launch_error() { "LAUNCH HELP" } else { "RELEASE NOTES" }
        }

        fn details_control_name(&self) -> &'static str {
            if self.has_launch_error() { "&Launch help" } else { "Release &notes" }
        }

        fn profile_status(&self) -> &'static str {
            if self.game_ready {
                "In game"
            } else if self.playing {
                "Starting CS:GO"
            } else if self.action_error.is_some() {
                "Action needs attention"
            } else if self.refresh_error.is_some() {
                "Last synced profile"
            } else if self.pairing {
                "Connecting account"
            } else if self.snapshot.is_some() {
                "Online · Ready"
            } else {
                "Connect with Steam"
            }
        }

        fn footer_status(&self) -> &str {
            if self.setup.preparing {"Finishing B2G files. This will only take a moment."}
            else if let Some(error)=&self.setup.install_error { error }
            else if self.needs_profile(){"Choose your name and region to finish setup."}
            else if self.setup.installing{self.install_detail()}
            else if !self.install_ready(){"Choose Install to get CS:GO ready on this PC."}
            else if self.action_error.is_some() {
                if self.action_error.as_deref() == Some(crate::FACEIT_LAUNCH_BLOCK) {
                    "Exit FACEIT from the system tray.\nThen press Play."
                } else if self.paired && self.tab != LauncherTab::Play {
                    "Launch failed. Open the Play tab\nand choose Launch Help."
                } else if self.paired {
                    "Launch failed. Open Launch Help\nfor the cause and next step."
                } else {
                    "Retry with Connect Account.\nMore help in Release Notes."
                }
            } else if self.refresh_error.is_some() {
                "Service unavailable. Refresh to retry.\nLast synced profile shown."
            } else {
                &self.status
            }
        }

        fn begin_refresh(&mut self) -> bool {
            if self.refreshing {
                return false;
            }
            self.refreshing = true;
            // A background refresh must not erase a failed GO/pair action or
            // replace an active session's status with account-sync progress.
            if self.snapshot.is_none() && !self.playing && !self.pairing && self.visible_error().is_none() {
                self.status = "Synchronizing account and service status…".to_string();
            }
            true
        }

        fn begin_pair(&mut self) -> bool {
            if self.pairing || self.playing {
                return false;
            }
            self.pairing = true;
            self.action_error = None;
            self.status = "Approve the one-time code in the browser window…".to_string();
            true
        }

        fn begin_play(&mut self) -> bool {
            if !self.paired || self.playing || self.pairing || self.account_blocks_play() || !self.install_ready() || self.needs_profile() {
                return false;
            }
            self.playing = true;
            self.game_ready = false;
            self.action_error = None;
            self.status = "Preparing owned inventory and starting CS:GO…".to_string();
            true
        }

        fn account_blocks_play(&self) -> bool {
            self.account.uninstall_started || matches!(self.account.active_task, Some(AccountTask::Repair | AccountTask::Uninstall | AccountTask::Logout))
        }

        fn primary_label(&self) -> &'static str {
            if self.setup.preparing {
                "FINISHING…"
            } else if self.pairing {
                "CONNECTING…"
            } else if self.setup.installing || self.setup.saving {
                "SETTING UP…"
            } else if !self.install_ready() {
                "INSTALL"
            } else if self.needs_profile() {
                "FINISH SETUP"
            } else if self.account_blocks_play() {
                "PLEASE WAIT…"
            } else if self.playing {
                if self.game_ready {
                    "GAME RUNNING"
                } else {
                    "STARTING…"
                }
            } else if self.pairing {
                "CONNECTING…"
            } else if self.paired {
                "PLAY"
            } else {
                "CONNECT ACCOUNT"
            }
        }

        // Return whether account data should be refreshed after this action.
        // This reducer is shared by the native message loop and regression tests.
        fn apply_event(&mut self, event: UiEvent) -> bool {
            match event {
                UiEvent::Setup(event) => return self.apply_setup_event(event),
                UiEvent::SnapshotRead {window,result} => {
                    if window==self.trading.window{return self.apply_event(UiEvent::Refreshed(result));}
                }
                UiEvent::Friends(result) => { self.friends.apply(result,self.trading.window); }
                UiEvent::Account(result) => {
                    let logout=result.window==self.trading.window&&result.epoch==self.account.epoch&&matches!(result.data,Ok(AccountData::LoggedOut(_)));
                    let warning=if let Ok(AccountData::LoggedOut(ref warning))=result.data{warning.clone()}else{None};
                    self.account.apply(result,self.trading.window);
                    if let (Some(snapshot),Some(player))=(&mut self.snapshot,&self.account.player) {
                        if let Some(region)=player["region"].as_str(){snapshot.region=region.into();}
                    }
                    if logout {
                        let window=self.trading.window;
                        self.paired=false;self.snapshot=None;self.refresh_error=None;self.refreshing=false;
                        self.trading=TradingState::default();self.trading.window=window+(1<<32);
                        self.account=AccountState::default();self.friends=FriendsState::default();
                        self.account.error=warning;
                        self.status="Account disconnected. Connect Account to sign in again.".into();
                    }
                }
                UiEvent::TradePolled {epoch,result} => { apply_trade_poll(&mut self.trading,epoch,result); }
                UiEvent::Trading(result) => {
                    let displayed=(self.tab == LauncherTab::Trading)&&result.window==self.trading.window&&result.view==self.trading.view
                        &&matches!(&result.data,Ok(TradeData::Offers(..)|TradeData::Offer(..)));
                    self.trading.apply(result);
                    if displayed&&self.trading.deferred.is_none() {
                        if let Some(overview)=&self.trading.overview {
                            if overview.latest_event_id!=self.trading.last_seen_requested {
                                let latest=overview.latest_event_id.clone();
                                self.trading.deferred=Some(TradeTask::Seen(latest));
                            }
                        }
                    }
                }
                UiEvent::Refreshed(Ok(snapshot)) => {
                    self.snapshot = Some(snapshot);
                    self.paired = true;
                    self.refreshing = false;
                    self.refresh_error = None;
                    if !self.playing && !self.pairing && self.action_error.is_none() {
                        self.status =
                            "Ready. Press Play, then choose a mode inside CS:GO.".to_string();
                    }
                }
                UiEvent::Refreshed(Err(error)) => {
                    self.refreshing = false;
                    let unpaired = error.contains("not connected")
                        || error.contains("authorization")
                        || error.contains("credential");
                    if unpaired {
                        self.paired = false;
                        self.snapshot = None;
                        if !self.playing && !self.pairing {
                            self.status =
                                "Connect once with Steam to activate this launcher.".to_string();
                        }
                    }
                    self.refresh_error = Some(error);
                }
                UiEvent::Paired(Ok(message)) => {
                    self.pairing = false;
                    self.paired = true;
                    self.action_error = None;
                    self.refresh_error = None;
                    self.status = message;
                    return true;
                }
                UiEvent::Paired(Err(error)) => {
                    self.pairing = false;
                    self.status =
                        "Account connection failed. Try Connect Account again.".to_string();
                    self.action_error = Some(error);
                }
                UiEvent::GameReady => {
                    if self.playing {
                        self.game_ready = true;
                        self.status =
                            "CS:GO is open. Choose Competitive or Deathmatch inside Play."
                                .to_string();
                    }
                }
                UiEvent::SessionFinished(result) => {
                    self.playing = false;
                    self.game_ready = false;
                    match result {
                        Ok(message) => self.status = message,
                        Err(error) => {
                            self.status =
                                "Game session failed. Details are in the launcher log.".to_string();
                            self.action_error = Some(error);
                        }
                    }
                    return true;
                }
            }
            false
        }
    }

    #[cfg(test)]
    mod state_tests {
        use super::*;

        fn profile() -> LauncherSnapshot {
            snapshot_from_bootstrap(&serde_json::json!({
                "player": {}, "gameProfile": {}, "platform": {}
            }))
            .unwrap()
        }

        fn paired_state() -> UiState {
            let mut state = UiState::default();
            state.apply_event(UiEvent::Refreshed(Ok(profile())));
            state
        }

        #[test]
        fn recovery_labels_are_truthful_without_changing_play_permission() {
            let mut state = render_tests::fixture();
            assert_eq!(state.primary_label(), "PLAY");
            state.action_error = Some("Missing managed game files, with long diagnostics".into());
            assert_eq!(state.profile_status(), "Action needs attention");
            assert!(state.footer_status().contains("Launch Help"));
            assert!(state.begin_play());
            assert_eq!(state.profile_status(), "Starting CS:GO");
            state.apply_event(UiEvent::GameReady);
            assert_eq!(state.profile_status(), "In game");
        }

        #[test]
        fn launch_failure_survives_immediate_and_periodic_refreshes() {
            let mut state = paired_state();
            assert!(state.begin_play());
            assert!(state.apply_event(UiEvent::SessionFinished(Err(
                crate::FACEIT_LAUNCH_BLOCK.into()
            ))));
            assert_eq!(state.primary_label(), "PLAY");
            let status = state.status.clone();
            for _ in 0..3 {
                assert!(state.begin_refresh());
                assert_eq!(state.visible_error(), Some(crate::FACEIT_LAUNCH_BLOCK));
                state.apply_event(UiEvent::Refreshed(Ok(profile())));
                assert_eq!(state.visible_error(), Some(crate::FACEIT_LAUNCH_BLOCK));
                assert_eq!(state.footer_status(), "Exit FACEIT from the system tray.\nThen press Play.");
                assert_eq!(state.details_label(), "LAUNCH HELP");
                assert_eq!(state.details_control_name(), "&Launch help");
                assert_eq!(state.status, status);
            }
            assert!(state.begin_play());
            assert_eq!(state.visible_error(), None);
            assert_eq!(state.details_label(), "RELEASE NOTES");
            assert_eq!(state.primary_label(), "STARTING…");
        }

        #[test]
        fn background_completions_cannot_hide_an_action_failure_in_either_order() {
            for refresh_finishes_first in [true, false] {
                let mut state = paired_state();
                state.begin_refresh();
                state.begin_play();
                let refresh = UiEvent::Refreshed(Ok(profile()));
                let failure = UiEvent::SessionFinished(Err("No CS:GO window opened.".into()));
                let events = if refresh_finishes_first {
                    [refresh, failure]
                } else {
                    [failure, refresh]
                };
                for event in events {
                    state.apply_event(event);
                }
                assert_eq!(state.visible_error(), Some("No CS:GO window opened."));
                assert!(!state.refreshing);
                assert!(!state.playing);
            }
        }

        #[test]
        fn refresh_errors_recover_without_overwriting_action_errors() {
            let mut state = paired_state();
            state.apply_event(UiEvent::Refreshed(Err("Network unavailable".into())));
            state.begin_refresh();
            assert_eq!(state.visible_error(), Some("Network unavailable"));
            state.apply_event(UiEvent::Refreshed(Ok(profile())));
            assert_eq!(state.visible_error(), None);

            state.begin_play();
            state.apply_event(UiEvent::SessionFinished(Err(
                "Close CS:GO and retry.".into()
            )));
            state.apply_event(UiEvent::Refreshed(Err("credential expired".into())));
            assert!(!state.paired);
            assert!(state.snapshot.is_none());
            assert_eq!(state.visible_error(), Some("Close CS:GO and retry."));
            assert!(!state.begin_play());
            assert_eq!(state.visible_error(), Some("Close CS:GO and retry."));
            assert!(state.begin_pair());
            state.apply_event(UiEvent::Paired(Ok("Connected".into())));
            assert_eq!(state.visible_error(), None);
        }

        #[test]
        fn only_a_verified_game_ready_event_switches_to_running() {
            let mut state = paired_state();
            state.begin_play();
            let starting_status = state.status.clone();
            assert_eq!(state.primary_label(), "STARTING…");
            assert!(!state.begin_play());
            assert!(!state.begin_pair());
            state.begin_refresh();
            assert!(!state.begin_refresh());
            state.apply_event(UiEvent::Refreshed(Ok(profile())));
            assert_eq!(state.status, starting_status);
            assert_eq!(state.primary_label(), "STARTING…");
            state.apply_event(UiEvent::GameReady);
            assert_eq!(state.primary_label(), "GAME RUNNING");
            let running_status = state.status.clone();
            state.begin_refresh();
            state.apply_event(UiEvent::Refreshed(Ok(profile())));
            assert_eq!(state.status, running_status);
            state.apply_event(UiEvent::SessionFinished(Ok("CS:GO closed".into())));
            assert_eq!(state.primary_label(), "PLAY");
            assert!(!state.game_ready);
            // A late ready message must not resurrect a finished session.
            state.apply_event(UiEvent::GameReady);
            assert_eq!(state.primary_label(), "PLAY");
            state.begin_play();
            assert_eq!(state.primary_label(), "STARTING…");
        }

        #[test]
        fn pairing_failure_survives_background_sync_until_an_explicit_retry() {
            let mut state = UiState::default();
            assert!(!state.begin_play());
            assert!(state.begin_pair());
            let pairing_status = state.status.clone();
            state.begin_refresh();
            assert_eq!(state.status, pairing_status);
            state.apply_event(UiEvent::Refreshed(Err("not connected".into())));
            state.apply_event(UiEvent::Paired(Err(
                "Authorization timed out. Try again.".into()
            )));
            state.begin_refresh();
            state.apply_event(UiEvent::Refreshed(Ok(profile())));
            assert_eq!(
                state.visible_error(),
                Some("Authorization timed out. Try again.")
            );
            assert!(state.begin_pair());
            assert_eq!(state.visible_error(), None);
        }
    }

    static STATE: OnceLock<Mutex<UiState>> = OnceLock::new();
    static EVENTS: OnceLock<Mutex<VecDeque<UiEvent>>> = OnceLock::new();

    fn state() -> &'static Mutex<UiState> {
        STATE.get_or_init(|| Mutex::new(UiState::default()))
    }

    fn events() -> &'static Mutex<VecDeque<UiEvent>> {
        EVENTS.get_or_init(|| Mutex::new(VecDeque::new()))
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    include!("launcher_ui/drawing.rs");
    include!("launcher_ui/trading.rs");
    include!("launcher_ui/account.rs");
    include!("launcher_ui/friends.rs");
    include!("launcher_ui/setup.rs");
    include!("launcher_ui/motion.rs");

    fn post_event(hwnd: HWND, event: UiEvent) {
        if unsafe { IsWindow(hwnd) } == 0 { return; }
        if let Ok(mut pending) = events().lock() {
            pending.push_back(event);
            unsafe { PostMessageW(hwnd, UI_EVENT, 0, 0) };
        }
    }

    fn refresh(hwnd: HWND) {
        let window;
        {
            let Ok(mut state) = state().lock() else {
                return;
            };
            if !state.begin_refresh() {
                return;
            }
            window=state.trading.window;
        }
        if state().lock().is_ok_and(|s|s.snapshot.is_none()) {unsafe { InvalidateRect(hwnd, ptr::null(), 0) };}
        let hwnd = hwnd as usize;
        thread::spawn(move || {
            let result = launcher_bootstrap().and_then(|value| snapshot_from_bootstrap(&value));
            post_event(hwnd as HWND, UiEvent::SnapshotRead {window,result});
        });
    }

    fn pair(hwnd: HWND) {
        let (window, epoch, cancelled);
        {
            let Ok(mut state) = state().lock() else {
                return;
            };
            if !state.begin_pair() {
                return;
            }
            state.tab=LauncherTab::Play;
            state.setup.pair_epoch+=1;
            state.setup.pair_code=None;
            state.setup.pair_url=None;
            state.setup.cancelled=std::sync::Arc::new(Mutex::new(false));
            (window,epoch,cancelled)=(state.trading.window,state.setup.pair_epoch,state.setup.cancelled.clone());
        }
        unsafe { InvalidateRect(hwnd, ptr::null(), 0) };
        let hwnd = hwnd as usize;
        thread::spawn(move || {
            let result = crate::authorize_launcher_with_progress(DEFAULT_API_ORIGIN, |code,url| {
                post_event(hwnd as HWND,UiEvent::Setup(SetupEvent::PairCode {window,epoch,code:code.into(),url:url.into()}));
            },&cancelled).map(|_| "Account connected. Finishing setup…".into());
            if let Err(error) = &result {
                log_launcher_event(&format!("account: connection failed: {error}"));
            }
            post_event(hwnd as HWND, UiEvent::Setup(SetupEvent::Paired {window,epoch,result}));
        });
    }

    fn play(hwnd: HWND) {
        {
            let Ok(mut state) = state().lock() else {
                return;
            };
            if !state.begin_play() {
                return;
            }
        }
        unsafe { InvalidateRect(hwnd, ptr::null(), 0) };
        let hwnd = hwnd as usize;
        thread::spawn(move || {
            let result = run_client_session_with_ready(|| {
                post_event(hwnd as HWND, UiEvent::GameReady);
            });
            post_event(hwnd as HWND, UiEvent::SessionFinished(result));
        });
    }

    fn open_url(url: &str) {
        let operation = wide("open");
        let url = wide(url);
        unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                operation.as_ptr(),
                url.as_ptr(),
                ptr::null(),
                ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        unsafe {
            match message {
                WM_CREATE => {
                    static WINDOW_SEQUENCE:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(1);
                    if let Ok(mut state)=state().lock() {state.trading.window=WINDOW_SEQUENCE.fetch_add(1,std::sync::atomic::Ordering::Relaxed);}
                    create_controls(hwnd);
                    create_trade_controls(hwnd);
                    create_account_controls(hwnd);
                    create_friends_controls(hwnd);
                    create_setup_controls(hwnd);
                    SetTimer(hwnd, REFRESH_TIMER, REFRESH_INTERVAL_MS, None);
                    SetTimer(hwnd, TRADE_TIMER, 5_000, None);
                    SetTimer(hwnd, SETUP_TIMER, 2_000, None);
                    check_setup(hwnd);
                    refresh(hwnd);
                    sync_controls(hwnd);
                    0
                }
                WM_TIMER if wparam == REFRESH_TIMER => {
                    refresh(hwnd);
                    if state().lock().is_ok_and(|s|s.tab!=LauncherTab::Friends){refresh_friends(hwnd,true,true);}
                    if state().lock().is_ok_and(|s|s.paired&&s.tab != LauncherTab::Trading&&!s.trading.busy) {
                        poll_trading(hwnd,TradeTask::Overview);
                    }
                    0
                }
                WM_TIMER if wparam == SETUP_TIMER => { check_setup(hwnd); 0 }
                WM_TIMER if wparam == MOTION_TIMER => {tick_motion(hwnd);0}
                WM_TIMER if wparam == TRADE_TIMER => {
                    if state().lock().is_ok_and(|s|s.tab==LauncherTab::Friends){refresh_friends(hwnd,true,false);}
                    if state().lock().is_ok_and(|s|s.paired&&(s.tab == LauncherTab::Trading)&&!s.trading.busy) { refresh_trading(hwnd,false); }
                    0
                }
                TRADE_IMAGES => {
                    if state().lock().is_ok_and(|s|s.tab == LauncherTab::Trading&&s.trading.window==wparam as u64) {
                        for id in TRADE_ITEM_BASE..TRADE_ITEM_BASE+24 {InvalidateRect(GetDlgItem(hwnd,id),ptr::null(),0);}
                    }
                    0
                }
                UI_EVENT => {
                    let pending = events()
                        .lock()
                        .map(|mut events| events.drain(..).collect::<Vec<_>>())
                        .unwrap_or_default();
                    let mut refresh_after = false;
                    let mut changed = false;
                    let mut account_connected = false;
                    let mut seen_after = None;
                    if let Ok(mut state) = state().lock() {
                        let paired_before=state.paired;
                        for event in pending {
                            if let UiEvent::Friends(result)=event {
                                let window=state.trading.window;
                                changed |= state.friends.apply(result,window);
                            } else if let UiEvent::TradePolled {epoch,result}=event {
                                let displayed=state.tab==LauncherTab::Trading && matches!(&result.data,Ok(TradeData::Offers(..)|TradeData::Offer(..)));
                                let applied=apply_trade_poll(&mut state.trading,epoch,result);
                                changed |= applied;
                                if applied && displayed {
                                    if let Some(o)=&state.trading.overview {
                                        if o.latest_event_id!=state.trading.last_seen_requested {seen_after=Some(o.latest_event_id.clone());}
                                    }
                                }
                            } else if let UiEvent::SnapshotRead {window,result:Ok(ref snapshot)}=event
                                && window==state.trading.window && state.snapshot.as_ref()==Some(snapshot) && state.refresh_error.is_none() {
                                state.refreshing=false;
                            } else {
                                changed = true;
                                refresh_after |= state.apply_event(event);
                            }
                        }
                        account_connected=!paired_before&&state.paired;
                    }
                    if !changed {return 0;}
                    if state().lock().is_ok_and(|s|s.account.uninstall_started) {
                        PostMessageW(hwnd,WM_CLOSE,0,0);
                        return 0;
                    }
                    InvalidateRect(hwnd, ptr::null(), 0);
                    if refresh_after
                        && state()
                            .lock()
                            .is_ok_and(|state| state.paired && !state.refreshing)
                    {
                        refresh(hwnd);
                    }
                    let deferred = state().lock().ok().and_then(|mut s|s.trading.deferred.take());
                    if let Some(task) = deferred { if matches!(task,TradeTask::Seen(_)){poll_trading(hwnd,task);}else{trade_task(hwnd,task);} }
                    if let Some(latest)=seen_after {poll_trading(hwnd,TradeTask::Seen(latest));}
                    let deferred = state().lock().ok().and_then(|mut s|if !s.account.busy{s.account.deferred.take()}else{None});
                    if let Some(task)=deferred {account_task(hwnd,task);}
                    sync_controls(hwnd);
                    if account_connected {refresh_account_tab(hwnd);refresh_friends(hwnd,true,true);}
                    show_account_details(hwnd);
                    0
                }
                WM_NCCALCSIZE => {
                    if wparam != 0 && IsZoomed(hwnd) != 0 {
                        let mut info: MONITORINFO = std::mem::zeroed();
                        info.cbSize = size_of::<MONITORINFO>() as u32;
                        if GetMonitorInfoW(
                            MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
                            &mut info,
                        ) != 0
                        {
                            (*(lparam as *mut NCCALCSIZE_PARAMS)).rgrc[0] = info.rcWork;
                        }
                    }
                    0
                }
                WM_NCHITTEST => {
                    let mut rect: RECT = std::mem::zeroed();
                    GetWindowRect(hwnd, &mut rect);
                    let x = (lparam as u32 & 0xffff) as i16 as i32 - rect.left;
                    let y = ((lparam as u32 >> 16) & 0xffff) as i16 as i32 - rect.top;
                    let dpi = GetDpiForWindow(hwnd).max(96) as i32;
                    let edge = 6 * dpi / 96;
                    if IsZoomed(hwnd) == 0 {
                        let left = x < edge;
                        let right = x >= rect.right - rect.left - edge;
                        let top = y < edge;
                        let bottom = y >= rect.bottom - rect.top - edge;
                        let hit = match (left, right, top, bottom) {
                            (true, _, true, _) => HTTOPLEFT,
                            (_, true, true, _) => HTTOPRIGHT,
                            (true, _, _, true) => HTBOTTOMLEFT,
                            (_, true, _, true) => HTBOTTOMRIGHT,
                            (true, _, _, _) => HTLEFT,
                            (_, true, _, _) => HTRIGHT,
                            (_, _, true, _) => HTTOP,
                            (_, _, _, true) => HTBOTTOM,
                            _ => HTCLIENT,
                        };
                        if hit != HTCLIENT {
                            return hit as LRESULT;
                        }
                    }
                    let client = logical_client(hwnd);
                    let lx = x * 96 / dpi;
                    let ly = y * 96 / dpi;
                    let over_control = control_rects(&layout(client), client.right)
                        .iter()
                        .any(|(_, r)| lx >= r.left && lx < r.right && ly >= r.top && ly < r.bottom);
                    if ly < 57 && !over_control {
                        HTCAPTION as LRESULT
                    } else {
                        HTCLIENT as LRESULT
                    }
                }
                WM_SIZE => {
                    if let Ok(mut state) = state().lock() {
                        state.maximized = IsZoomed(hwnd) != 0;
                    }
                    SetWindowTextW(
                        GetDlgItem(hwnd, MAXIMIZE_ID),
                        wide(if IsZoomed(hwnd) != 0 {
                            "Restore"
                        } else {
                            "Maximize"
                        })
                        .as_ptr(),
                    );
                    resize_controls(hwnd);
                    InvalidateRect(hwnd, ptr::null(), 0);
                    0
                }
                WM_DPICHANGED => {
                    let r = &*(lparam as *const RECT);
                    SetWindowPos(
                        hwnd,
                        ptr::null_mut(),
                        r.left,
                        r.top,
                        r.right - r.left,
                        r.bottom - r.top,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                    resize_controls(hwnd);
                    0
                }
                WM_GETMINMAXINFO => {
                    let info = &mut *(lparam as *mut MINMAXINFO);
                    let dpi = GetDpiForWindow(hwnd).max(96);
                    info.ptMinTrackSize.x = 1024 * dpi as i32 / 96;
                    info.ptMinTrackSize.y = 664 * dpi as i32 / 96;
                    0
                }
                WM_DRAWITEM => {
                    let draw = &*(lparam as *const DRAWITEMSTRUCT);
                    let label = trade_edit_text(hwnd,draw.CtlID as i32);
                    if let Ok(state) = state().lock() {
                        let saved = SaveDC(draw.hDC);
                        // Owner-draw rectangles are physical pixels. Clear all of
                        // them before logical scaling, including fractional-DPI edges.
                        SetMapMode(draw.hDC, MM_TEXT);
                        let mut objects = PaintObjects::new();
                        FillRect(
                            draw.hDC,
                            &draw.rcItem,
                            objects.brush(if draw.CtlID as i32 == DETAILS_ID {
                                PANEL
                            } else {
                                BG
                            }),
                        );
                        let dpi = GetDpiForWindow(hwnd).max(96);
                        scale_dc(draw.hDC, dpi);
                        let r = box_rect(
                            0,
                            0,
                            (draw.rcItem.right - draw.rcItem.left) * 96 / dpi as i32,
                            (draw.rcItem.bottom - draw.rcItem.top) * 96 / dpi as i32,
                        );
                        if draw.CtlID >= 5000 {
                            paint_friends_button(draw.hDC,r,draw.CtlID as i32,&state,draw.itemState & ODS_SELECTED != 0,draw.itemState & ODS_FOCUS != 0);
                        } else if draw.CtlID >= 4000 {
                            paint_setup_button(draw.hDC,r,draw.CtlID as i32,&state,
                                draw.itemState & ODS_SELECTED != 0,draw.itemState & ODS_FOCUS != 0);
                        } else if draw.CtlID >= 3000 {
                            paint_account_button(draw.hDC,r,draw.CtlID as i32,&state,
                                draw.itemState & ODS_SELECTED != 0,draw.itemState & ODS_FOCUS != 0);
                        } else if draw.CtlID >= 2000 {
                            paint_trade_button(draw.hDC,r,draw.CtlID as i32,&state.trading,
                                draw.itemState & ODS_SELECTED != 0,draw.itemState & ODS_FOCUS != 0,
                                draw.itemState & windows_sys::Win32::UI::Controls::ODS_DISABLED == 0,
                                state.hovered_button == Some(draw.CtlID as i32),&label);
                        } else { paint_button(
                            draw.hDC,
                            r,
                            draw.CtlID as i32,
                            &state,
                            draw.itemState & ODS_SELECTED != 0,
                            draw.itemState & ODS_FOCUS != 0,
                        ); }
                        RestoreDC(draw.hDC, saved);
                    }
                    1
                }
                WM_COMMAND if (wparam >> 16) as u32 == BN_CLICKED => {
                    match (wparam & 0xffff) as i32 {
                        PLAY_TAB_ID | TRADE_TAB_ID | HISTORY_TAB_ID | SETTINGS_TAB_ID | FRIENDS_TAB_ID => select_tab(hwnd,(wparam & 0xffff) as i32),
                        PRIMARY_ID => {
                            setup_primary(hwnd);
                        }
                        REFRESH_ID => {
                            if state().lock().is_ok_and(|s|s.tab == LauncherTab::Friends) { refresh_friends(hwnd,false,false); }
                            else if state().lock().is_ok_and(|s|s.tab == LauncherTab::Trading) { refresh_trading(hwnd,true); }
                            else if state().lock().is_ok_and(|s|matches!(s.tab,LauncherTab::Settings|LauncherTab::History)) { refresh_account_tab(hwnd); }
                            else { refresh(hwnd); }
                        }
                        ACCOUNT_ID => select_tab(hwnd,SETTINGS_TAB_ID),
                        UPDATE_ID => {
                            let url = state().lock().ok().and_then(|s| {
                                s.snapshot
                                    .as_ref()
                                    .and_then(|s| s.update_download_url.clone())
                            });
                            if let Some(url) = url {
                                open_url(&url);
                            }
                        }
                        DETAILS_ID | NEWS_ID => {
                            show_details(hwnd);
                        }
                        MINIMIZE_ID => {
                            SendMessageW(hwnd, WM_SYSCOMMAND, SC_MINIMIZE as usize, 0);
                        }
                        MAXIMIZE_ID => {
                            SendMessageW(
                                hwnd,
                                WM_SYSCOMMAND,
                                if IsZoomed(hwnd) != 0 {
                                    SC_RESTORE
                                } else {
                                    SC_MAXIMIZE
                                } as usize,
                                0,
                            );
                        }
                        CLOSE_ID => {
                            PostMessageW(hwnd, WM_CLOSE, 0, 0);
                        }
                        id if id >= 5000 => friends_command(hwnd,id),
                        id if id >= 4000 => setup_command(hwnd,id),
                        id if id >= 3000 => account_command(hwnd,id),
                        id if id >= 2000 => trade_command(hwnd,id),
                        _ => return DefWindowProcW(hwnd, message, wparam, lparam),
                    }
                    sync_controls(hwnd);
                    0
                }
                WM_COMMAND if (wparam >> 16) as u32 == EN_CHANGE => {
                    friends_edit_changed(hwnd,(wparam & 0xffff) as i32);
                    setup_edit_changed(hwnd,(wparam & 0xffff) as i32);
                    trade_edit_changed(hwnd,(wparam & 0xffff) as i32);
                    0
                }
                WM_CTLCOLOREDIT => trade_edit_colors(wparam as HDC),
                WM_CTLCOLORSTATIC if (GetDlgCtrlID(lparam as HWND)>=4000) => setup_static_colors(wparam as HDC),
                WM_MOUSEMOVE => {
                    let dpi=GetDpiForWindow(hwnd).max(96) as i32;
                    motion_mouse(hwnd,(lparam as u32&0xffff) as i16 as i32*96/dpi,((lparam as u32>>16)&0xffff) as i16 as i32*96/dpi);
                    let mut track=TRACKMOUSEEVENT{cbSize:size_of::<TRACKMOUSEEVENT>() as u32,dwFlags:TME_LEAVE,hwndTrack:hwnd,dwHoverTime:0};TrackMouseEvent(&mut track);0
                }
                WM_MOUSELEAVE => {motion_mouse(hwnd,-1,-1);0}
                WM_MOUSEWHEEL if state().lock().is_ok_and(|s|s.tab == LauncherTab::Trading) => {
                    trade_scroll(hwnd,wparam,lparam); 0
                }
                WM_PRINTCLIENT => {
                    let saved = SaveDC(wparam as HDC);
                    let client = logical_client(hwnd);
                    scale_dc(wparam as HDC, GetDpiForWindow(hwnd).max(96));
                    if let Ok(state) = state().lock() {
                        paint_surface(wparam as HDC, client.right, client.bottom, &state);
                    }
                    RestoreDC(wparam as HDC, saved);
                    0
                }
                WM_PAINT => {
                    paint(hwnd);
                    0
                }
                WM_ERASEBKGND => 1,
                WM_CLOSE if state().lock().is_ok_and(|state| state.setup.preparing) => {
                    MessageBoxW(hwnd,wide("B2G is finishing the game files. This window can close as soon as setup finishes.").as_ptr(),wide("Finishing setup").as_ptr(),MB_OK|MB_ICONINFORMATION);0
                }
                WM_CLOSE if state().lock().is_ok_and(|state| state.playing) => {
                    MessageBoxW(
                        hwnd,
                        wide("Keep B2G open while CS:GO is starting or running so matchmaking and inventory stay connected.\n\nYou can minimize this window. Close CS:GO first when you want to exit the launcher.").as_ptr(),
                        wide("CS:GO is using B2G").as_ptr(),
                        MB_OK | MB_ICONINFORMATION,
                    );
                    0
                }
                WM_DESTROY => {
                    if let Ok(mut state)=state().lock() {
                        if let Ok(mut cancelled)=state.setup.cancelled.lock(){*cancelled=true;}
                        state.trading.window=0;
                        if let Some(loader)=state.trading.thumbnails.take(){loader.stop();}
                    }
                    KillTimer(hwnd,TRADE_TIMER);
                    KillTimer(hwnd,REFRESH_TIMER);
                    KillTimer(hwnd,SETUP_TIMER);
                    KillTimer(hwnd,MOTION_TIMER);
                    PostQuitMessage(0);
                    0
                }
                _ => DefWindowProcW(hwnd, message, wparam, lparam),
            }
        }
    }

    pub(super) fn run() -> Result<(), String> {
        log_launcher_event("ui: opening the launcher dashboard");
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        load_fonts();
        if let Ok(mut state) = state().lock() {
            *state = UiState::default();
        }
        if let Ok(mut events) = events().lock() {
            events.clear();
        }
        let instance: HINSTANCE = unsafe { GetModuleHandleW(ptr::null()) };
        if instance.is_null() {
            return Err("Windows could not initialize the B2G launcher window.".to_string());
        }
        let class_name = wide("B2GLauncherWindowV1");
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: unsafe { LoadCursorW(ptr::null_mut(), IDC_ARROW) },
            hbrBackground: ptr::null_mut(),
            lpszClassName: class_name.as_ptr(),
            ..unsafe { std::mem::zeroed() }
        };
        if unsafe { RegisterClassExW(&class) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(1410) {
                return Err(format!(
                    "Windows could not register the launcher window: {error}"
                ));
            }
        }
        let title = wide("B2G Launcher · Founders Playtest");
        let dpi = unsafe { GetDpiForSystem() }.max(96) as i32;
        let mut work_area: RECT = unsafe { std::mem::zeroed() };
        unsafe {
            SystemParametersInfoW(SPI_GETWORKAREA, 0, (&mut work_area as *mut RECT).cast(), 0);
        }
        let width = (WINDOW_WIDTH * dpi / 96).min((work_area.right - work_area.left).max(1024));
        let height = (WINDOW_HEIGHT * dpi / 96).min((work_area.bottom - work_area.top).max(700));
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                width,
                height,
                ptr::null_mut(),
                ptr::null_mut(),
                instance,
                ptr::null(),
            )
        };
        if hwnd.is_null() {
            return Err(format!(
                "Windows could not create the launcher window: {}",
                std::io::Error::last_os_error()
            ));
        }
        log_launcher_event("ui: native window created");
        unsafe {
            ShowWindow(hwnd, SW_SHOWNORMAL);
            UpdateWindow(hwnd);
        }
        log_launcher_event("ui: dashboard painted; message loop ready");
        let mut message: MSG = unsafe { std::mem::zeroed() };
        loop {
            let result = unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) };
            if result == -1 {
                return Err("The Windows launcher message loop failed.".to_string());
            }
            if result == 0 {
                break;
            }
            unsafe {
                let root = GetAncestor(message.hwnd, GA_ROOT);
                if message.message == WM_KEYDOWN
                    && message.wParam == 27
                    && root != hwnd
                    && GetWindow(root, GW_OWNER) == hwnd
                {
                    SendMessageW(root, WM_CLOSE, 0, 0);
                    continue;
                }
                if IsDialogMessageW(root, &message) == 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        }
        Ok(())
    }
}

pub fn run_launcher_ui() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::run()
    }
    #[cfg(not(windows))]
    {
        Err("The B2G launcher dashboard is only supported on Windows.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_history_is_bounded_and_preserves_real_empty_content() {
        assert!(!release_history(None).is_empty());
        assert!(release_history(Some(&serde_json::json!({"history":[]}))).is_empty());
        let changes = vec![serde_json::json!({"kind":"unknown","text":"x".repeat(500)}); 20];
        let history = vec![
            serde_json::json!({"version":"0.2.26","date":"2026-09-07 injected","changes":changes});
            20
        ];
        let notes = release_history(Some(&serde_json::json!({"history":history})));
        assert_eq!(notes.len(), 6);
        assert_eq!(notes[0].date, "2026-09-07");
        assert_eq!(notes[0].changes.len(), 8);
        assert_eq!(notes[0].changes[0].0, "changed");
        assert_eq!(notes[0].changes[0].1.len(), 240);
        assert!(
            release_history(Some(
                &serde_json::json!({"history":[{"version":"../../bad","changes":[]}]})
            ))
            .is_empty()
        );
    }

    #[test]
    fn update_download_stays_on_the_official_origin_and_requires_a_newer_valid_version() {
        for (version, available) in [
            ("999.0.0", true),
            ("0.0.1", false),
            ("../../bad", false),
            ("1.2.3?redirect=evil", false),
        ] {
            let snapshot=snapshot_from_bootstrap(&serde_json::json!({"player":{},"gameProfile":{},"platform":{},"launcher":{"content":{"releaseVersion":version}}})).unwrap();
            assert_eq!(snapshot.update_download_url.is_some(), available);
            if let Some(url) = snapshot.update_download_url {
                assert_eq!(
                    url,
                    "https://play.back2go.net/downloads/b2g-launcher-v999.0.0-windows-x86_64.exe"
                );
            }
        }
    }

    #[test]
    fn builds_a_bounded_launcher_snapshot_from_authoritative_state() {
        let snapshot = snapshot_from_bootstrap(&serde_json::json!({
            "player": {
                "displayName": "cubsfan49",
                "region": "NA Central",
                "rank": { "name": "Master Guardian I", "rating": 1525 }
            },
            "queue": { "phase": "idle" },
            "platform": { "onlinePlayers": 12, "activeMatches": 3 },
            "gameProfile": { "playerLevel": 4, "playerXp": 380 },
            "launcher": {
                "content": {
                    "version": 1,
                    "releaseVersion": env!("CARGO_PKG_VERSION"),
                    "channel": "Founders Playtest",
                    "publishedAt": "2026-09-03T03:20:00.000Z",
                    "changelog": {
                        "title": "Native match acceptance",
                        "summary": "Accept Competitive matches inside Panorama."
                    },
                    "news": {
                        "title": "Panorama stays",
                        "summary": "The original menu remains active."
                    }
                }
            }
        }))
        .unwrap();
        assert_eq!(snapshot.display_name, "cubsfan49");
        assert_eq!(snapshot.rank, "Master Guardian I");
        assert_eq!(snapshot.profile_level, 4);
        assert_eq!(snapshot.profile_xp, 380);
        assert_eq!(snapshot.service_drop_count, 0);
        assert_eq!(snapshot.channel, "Founders Playtest");
        assert_eq!(snapshot.changelog_title, "Native match acceptance");
        assert!(snapshot.update_status.starts_with("CURRENT"));
    }

    #[test]
    fn rejects_incomplete_remote_launcher_state() {
        assert!(snapshot_from_bootstrap(&serde_json::json!({ "player": {} })).is_err());
    }

    #[test]
    fn labels_the_running_executable_separately_from_the_published_download() {
        let snapshot = snapshot_from_bootstrap(&serde_json::json!({
            "player": {}, "gameProfile": {}, "platform": {},
            "launcher": { "content": { "releaseVersion": "0.2.16", "channel": "Founders Playtest" } }
        })).unwrap();
        let identity = launcher_identity_line(Some(&snapshot.channel));
        assert!(identity.starts_with(&format!("LAUNCHER v{}", env!("CARGO_PKG_VERSION"))));
        assert!(!identity.contains("0.2.16"));
        assert_eq!(snapshot.update_status, "PUBLISHED  ·  v0.2.16");
        assert_eq!(launcher_identity_line(None), identity);
    }

    #[test]
    fn does_not_claim_current_when_release_information_is_missing_or_invalid() {
        for candidate in [
            None,
            Some(""),
            Some("not-a-version"),
            Some("999999999999999999999999999999.0.0"),
        ] {
            assert_eq!(launcher_update_status(candidate), "RELEASE UNKNOWN");
        }
        assert!(launcher_update_status(Some(env!("CARGO_PKG_VERSION"))).starts_with("CURRENT"));
        assert_eq!(
            launcher_update_status(Some("999.0.0")),
            "UPDATE AVAILABLE  ·  v999.0.0"
        );
    }

    #[test]
    fn sanitizes_remote_text() {
        let snapshot = snapshot_from_bootstrap(&serde_json::json!({
            "player": {
                "displayName": "Player\nInjected",
                "region": "NA Central",
                "rank": { "name": "Silver I", "rating": 0 }
            },
            "queue": { "phase": "idle" },
            "platform": { "onlinePlayers": 1, "activeMatches": 0 },
            "gameProfile": { "playerLevel": 3, "playerXp": 0 },
            "launcher": {
                "content": {
                    "releaseVersion": "999.0.0",
                    "channel": "Founders\nPlaytest",
                    "changelog": {
                        "title": "\n\t",
                        "summary": "Line one\nLine two"
                    },
                    "news": { "title": "Status", "summary": "All good" }
                }
            }
        }))
        .unwrap();
        assert_eq!(snapshot.display_name, "Player Injected");
        assert_eq!(snapshot.channel, "Founders Playtest");
        assert_eq!(snapshot.changelog_title, "B2G client session is ready");
        assert_eq!(snapshot.changelog_summary, "Line one Line two");
        assert_eq!(snapshot.update_status, "UPDATE AVAILABLE  ·  v999.0.0");
    }
}

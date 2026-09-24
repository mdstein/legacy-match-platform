// Native account and match-history extensions of the established launcher.
// Keep account I/O off the window thread and unsaved preferences in local state.
const HISTORY_TAB_ID: i32 = 1013;
const SETTINGS_TAB_ID: i32 = 1014;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LauncherTab {
    Play,
    Trading,
    Friends,
    History,
    Settings,
}
const SETTINGS_ACCOUNT: i32 = 3000;
const SETTINGS_SAVE: i32 = 3010;
const SETTINGS_RESET: i32 = 3011;
const SETTINGS_REGION: i32 = 3020;
const SETTINGS_MODE: i32 = 3021;
const SETTINGS_INVITES: i32 = 3022;
const SETTINGS_VISIBILITY: i32 = 3023;
const SETTINGS_MOTION: i32 = 3024;
const SETTINGS_MATCH_NOTICE: i32 = 3025;
const SETTINGS_UPDATES: i32 = 3026;
const SETTINGS_CONSOLE: i32 = 3030;
const SETTINGS_LOG: i32 = 3031;
const SETTINGS_DIAGNOSTICS: i32 = 3032;
const SETTINGS_REPAIR: i32 = 3033;
const SETTINGS_LOGOUT: i32 = 3034;
const SETTINGS_AVATAR: i32 = 3035;
const SETTINGS_UNINSTALL: i32 = 3036;
const SETTINGS_INSTALL: i32 = 3037;
const HISTORY_PREV: i32 = 3040;
const HISTORY_NEXT: i32 = 3041;
const HISTORY_DEMO: i32 = 3042;
const HISTORY_DETAILS: i32 = 3043;
const HISTORY_ROW: i32 = 3100;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AccountSettings {
    region: String,
    preferred_mode: String,
    profile_visibility: String,
    allow_party_invites: bool,
    match_notifications: bool,
    product_updates: bool,
    reduced_motion: bool,
}
impl AccountSettings {
    fn from_player(player: &Value) -> Result<Self, String> {
        let mut value = player["settings"].clone();
        if !value.is_object() {
            return Err("Account preferences are unavailable. Refresh to retry.".into());
        }
        value["region"] = player["region"].clone();
        serde_json::from_value(value)
            .map_err(|_| "B2G returned incomplete account preferences. Refresh to retry.".into())
    }
}
#[derive(Debug, Clone, Default)]
struct AccountState {
    player: Option<Value>,
    saved: Option<AccountSettings>,
    draft: Option<AccountSettings>,
    section: i32,
    busy: bool,
    active_task: Option<AccountTask>,
    error: Option<String>,
    notice: String,
    matches: Vec<Value>,
    total: usize,
    offset: usize,
    history_loaded: bool,
    selected: Option<Value>,
    details: Option<Value>,
    pending_details: bool,
    downloaded: Option<(String, std::path::PathBuf)>,
    epoch: u64,
    deferred: Option<AccountTask>,
    uninstall_started: bool,
}
impl AccountState {
    fn dirty(&self) -> bool {
        self.saved != self.draft
    }
    fn apply(&mut self, result: AccountResult, window: u64) {
        if result.window != window || result.epoch != self.epoch {
            return;
        }
        self.busy = false;
        self.active_task = None;
        match result.data {
            Err(error) => self.error = Some(error),
            Ok(data) => {
                self.error = None;
                match data {
                    AccountData::Player(player, saved) => {
                        match AccountSettings::from_player(&player) {
                            Ok(settings) => {
                                if saved || !self.dirty() {
                                    self.draft = Some(settings.clone());
                                }
                                self.saved = Some(settings);
                                self.player = Some(player);
                                if saved {
                                    self.notice = "Settings saved to your B2G account.".into();
                                }
                            }
                            Err(error) => self.error = Some(error),
                        }
                    }
                    AccountData::History(page, offset) => {
                        self.matches = page["entries"].as_array().cloned().unwrap_or_default();
                        self.total = page["total"].as_u64().unwrap_or(0) as usize;
                        self.offset = offset;
                        self.history_loaded = true;
                        self.selected = None;
                        self.details = None;
                    }
                    AccountData::Details(detail) => {
                        self.details = Some(detail);
                        self.pending_details = true;
                    }
                    AccountData::Notice(notice) => self.notice = notice,
                    AccountData::Downloaded(id, path) => {
                        self.notice =
                            "Demo verified and saved. Open its folder to use it in CS:GO.".into();
                        self.downloaded = Some((id, path));
                    }
                    AccountData::Diagnostics(value) => {
                        self.details = Some(serde_json::json!({"diagnostics":value}));
                        self.pending_details = true;
                    }
                    AccountData::LoggedOut(_) => {}
                    AccountData::UninstallStarted => self.uninstall_started=true,
                }
            }
        }
    }
}
#[derive(Debug, Clone)]
enum AccountTask {
    Load,
    Save(AccountSettings),
    History(usize),
    Details(String),
    Demo(Value),
    Diagnostics,
    Repair,
    Uninstall,
    Logout,
}
#[derive(Debug)]
enum AccountData {
    Player(Value, bool),
    History(Value, usize),
    Details(Value),
    Downloaded(String, std::path::PathBuf),
    Notice(String),
    Diagnostics(String),
    LoggedOut(Option<String>),
    UninstallStarted,
}
#[derive(Debug)]
struct AccountResult {
    window: u64,
    epoch: u64,
    data: Result<AccountData, String>,
}

fn account_task(hwnd: HWND, task: AccountTask) {
    let (window, epoch) = {
        let Ok(mut s) = state().lock() else {
            return;
        };
        if s.account.uninstall_started {return;}
        if s.account.busy {
            if matches!(task, AccountTask::Load | AccountTask::History(_)) {
                s.account.deferred = Some(task);
            }
            return;
        }
        if (s.playing || s.setup.installing || s.setup.preparing) && matches!(task, AccountTask::Repair | AccountTask::Uninstall | AccountTask::Logout) {
            return;
        }
        s.account.busy = true;
        s.account.active_task = Some(task.clone());
        s.account.error = None;
        s.account.notice.clear();
        s.account.epoch += 1;
        (s.trading.window, s.account.epoch)
    };
    let handle = hwnd as usize;
    thread::spawn(move || {
        let data = (|| -> Result<AccountData, String> {
            match task {
                AccountTask::Diagnostics => {
                    return Ok(AccountData::Diagnostics(
                        serde_json::to_string_pretty(&crate::game_diagnostics()?)
                            .map_err(|e| e.to_string())?,
                    ));
                }
                AccountTask::Repair => return crate::repair_game(false).map(AccountData::Notice),
                AccountTask::Uninstall => return crate::uninstall::begin().map(|_|AccountData::UninstallStarted),
                AccountTask::Logout => {
                    let warning=crate::revoke_launcher().err();
                    if crate::read_launcher_credential()?.is_none(){return Ok(AccountData::LoggedOut(warning));}
                    return Err(warning.unwrap_or_else(||"Could not disconnect this account. Retry.".into()));
                }
                _ => {}
            }
            let api = TradingApi::connected().map_err(|e| e.message)?;
            let read = |path: &str| {
                api.launcher_request::<Value>(path, None)
                    .map_err(|e| e.message)
            };
            match task {
                AccountTask::Load => Ok(AccountData::Player(
                    read("/api/launcher/v1/account")?,
                    false,
                )),
                AccountTask::Save(settings) => Ok(AccountData::Player(
                    api.launcher_request(
                        "/api/launcher/v1/account/settings",
                        Some(&serde_json::to_value(settings).map_err(|e| e.to_string())?),
                    )
                    .map_err(|e| e.message)?,
                    true,
                )),
                AccountTask::History(offset) => Ok(AccountData::History(
                    read(&format!("/api/launcher/v1/matches?limit=8&offset={offset}"))?,
                    offset,
                )),
                AccountTask::Details(id) => Ok(AccountData::Details(read(&format!(
                    "/api/launcher/v1/matches/{id}"
                ))?)),
                AccountTask::Demo(value) => {
                    let id = value["id"].as_str().ok_or("Select a match first.")?;
                    let detail = read(&format!("/api/launcher/v1/matches/{id}"))?;
                    let path = api
                        .download_demo(id, &detail["demo"])
                        .map_err(|e| e.message)?;
                    Ok(AccountData::Downloaded(id.into(), path))
                }
                _ => unreachable!(),
            }
        })();
        post_event(
            handle as HWND,
            UiEvent::Account(AccountResult {
                window,
                epoch,
                data,
            }),
        );
    });
    sync_controls(hwnd);
    unsafe {
        InvalidateRect(hwnd, ptr::null(), 0);
    }
}
fn select_tab(hwnd: HWND, id: i32) {
    let tab = match id {
        TRADE_TAB_ID => LauncherTab::Trading,
        FRIENDS_TAB_ID => LauncherTab::Friends,
        HISTORY_TAB_ID => LauncherTab::History,
        SETTINGS_TAB_ID => LauncherTab::Settings,
        _ => LauncherTab::Play,
    };
    let load = {
        let Ok(mut s) = state().lock() else {
            return;
        };
        s.tab = tab;
        s.paired
            && match tab {
                LauncherTab::Settings => s.account.player.is_none(),
                LauncherTab::History => !s.account.history_loaded,
                _ => false,
            }
    };
    if tab == LauncherTab::Friends { refresh_friends(hwnd,false,false); }
    if tab == LauncherTab::Trading {
        refresh_trading(hwnd, false);
    }
    if load {
        refresh_account_tab(hwnd);
    }
    sync_controls(hwnd);
    unsafe {
        InvalidateRect(hwnd, ptr::null(), 0);
    }
}
fn refresh_account_tab(hwnd: HWND) {
    let task = state().lock().ok().and_then(|s| match s.tab {
        LauncherTab::Settings => Some(AccountTask::Load),
        LauncherTab::History => Some(AccountTask::History(s.account.offset)),
        _ => None,
    });
    if let Some(task) = task {
        account_task(hwnd, task);
    }
}

struct AccountControl {
    id: i32,
    rect: BoxRect,
    label: String,
    enabled: bool,
    selected: bool,
}
fn account_controls(width: i32, height: i32, s: &UiState) -> Vec<AccountControl> {
    let mut controls = vec![];
    let a = &s.account;
    let left = 260;
    let right = width - 36;
    let content_width = right - left;
    let mut add = |id, rect, label: String, enabled, selected| {
        controls.push(AccountControl {
            id,
            rect,
            label,
            enabled,
            selected,
        })
    };
    if s.tab == LauncherTab::Settings {
        for (i, label) in [
            "Account",
            "Matchmaking",
            "Privacy & notifications",
            "Launcher & debugging",
            "Installation",
        ]
        .iter()
        .enumerate()
        {
            add(
                SETTINGS_ACCOUNT + i as i32,
                box_rect(28, 132 + i as i32 * 48, 200, 40),
                label.to_string(),
                true,
                a.section == i as i32,
            );
        }
        let row = |index: i32| box_rect(right - 210, 145 + index * 72, 210, 36);
        if let Some(d) = &a.draft {
            match a.section {
                1 => {
                    add(SETTINGS_REGION, row(0), d.region.clone(), !a.busy, false);
                    add(
                        SETTINGS_MODE,
                        row(1),
                        if d.preferred_mode == "deathmatch" {
                            "Deathmatch"
                        } else {
                            "Competitive 5v5"
                        }
                        .into(),
                        !a.busy,
                        false,
                    );
                    add(
                        SETTINGS_INVITES,
                        row(2),
                        on_off(d.allow_party_invites),
                        !a.busy,
                        d.allow_party_invites,
                    );
                }
                2 => {
                    add(
                        SETTINGS_VISIBILITY,
                        row(0),
                        match d.profile_visibility.as_str() {
                            "players" => "Signed-in players",
                            "private" => "Private",
                            _ => "Public",
                        }
                        .into(),
                        !a.busy,
                        false,
                    );
                    for (i, id, value) in [
                        (1, SETTINGS_MOTION, d.reduced_motion),
                        (2, SETTINGS_MATCH_NOTICE, d.match_notifications),
                        (3, SETTINGS_UPDATES, d.product_updates),
                    ] {
                        add(id, row(i), on_off(value), !a.busy, value);
                    }
                }
                _ => {}
            }
        }
        if a.section == 0 {
            add(
                SETTINGS_AVATAR,
                box_rect(right - 146, 152, 146, 36),
                crate::profile_icon_label(&crate::profile_icon()).to_string(),
                true,
                false,
            );
            add(
                SETTINGS_LOGOUT,
                box_rect(left, 362, 190, 38),
                "Disconnect this account".into(),
                s.paired && !s.playing && !a.busy,
                false,
            );
        }
        if a.section == 3 {
            add(
                SETTINGS_CONSOLE,
                row(0),
                on_off(crate::console::visible()),
                true,
                crate::console::visible(),
            );
            add(
                SETTINGS_LOG,
                row(1),
                "Open launcher log".into(),
                true,
                false,
            );
            add(
                SETTINGS_DIAGNOSTICS,
                row(2),
                "View diagnostics".into(),
                !a.busy,
                false,
            );
            add(
                SETTINGS_REPAIR,
                row(3),
                if s.playing {
                    "Close CS:GO to repair"
                } else {
                    "Repair game integration"
                }
                .into(),
                !s.playing && !a.busy,
                false,
            );
        }
        if a.section == 4 {
            let ready=s.setup.installation.as_ref().is_some_and(|i|i.ready);
            let busy=s.playing||a.busy||a.uninstall_started||s.setup.installing||s.setup.preparing;
            add(SETTINGS_INSTALL,row(0),if s.setup.installing {"Installing…"}else if ready {"Installed"}else{"Install CS:GO"}.into(),!ready&&!busy,false);
            add(SETTINGS_REPAIR,row(1),if s.playing {"Close CS:GO to repair"}else{"Repair game integration"}.into(),ready&&!busy,false);
            add(SETTINGS_UNINSTALL,row(2),if s.playing {"Close CS:GO to uninstall"}else if matches!(a.active_task,Some(AccountTask::Uninstall)){"Removing B2G…"}else{"Uninstall B2G…"}.into(),!busy,false);
        }
        if matches!(a.section, 1 | 2) {
            add(
                SETTINGS_SAVE,
                box_rect(right - 166, height - 184, 166, 40),
                if matches!(a.active_task,Some(AccountTask::Save(_))) { "Saving…" } else { "Save settings" }.into(),
                a.dirty() && !a.busy,
                false,
            );
            add(
                SETTINGS_RESET,
                box_rect(right - 302, height - 184, 124, 40),
                "Discard changes".into(),
                a.dirty() && !a.busy,
                false,
            );
        }
    } else if s.tab == LauncherTab::History {
        let rows = ((height - 330) / 48).clamp(1, 8) as usize;
        // The API page is eight rows; compact windows show the same page using
        // a denser 38px rhythm, keeping every result reachable without clipping.
        let row_height = if rows < 8 { 38 } else { 48 };
        for (i, m) in a.matches.iter().take(8).enumerate() {
            add(
                HISTORY_ROW + i as i32,
                box_rect(28, 168 + i as i32 * row_height, width - 56, row_height - 2),
                format!(
                    "{} · {} · {} · {} kills, {} deaths · {} Elo",
                    field(m, "map"),
                    field(m, "playedAt"),
                    field(m, "score"),
                    m["kills"],
                    m["deaths"],
                    m["ratingDelta"]
                ),
                !a.busy,
                a.selected.as_ref().is_some_and(|v| v["id"] == m["id"]),
            );
        }
        add(
            HISTORY_PREV,
            box_rect(28, height - 184, 100, 38),
            "Previous".into(),
            a.offset > 0 && !a.busy,
            false,
        );
        add(
            HISTORY_NEXT,
            box_rect(140, height - 184, 100, 38),
            "Next".into(),
            a.offset + 8 < a.total && !a.busy,
            false,
        );
        add(
            HISTORY_DETAILS,
            box_rect(width - 378, height - 184, 156, 38),
            "View match details".into(),
            a.selected.is_some() && !a.busy,
            false,
        );
        let downloaded = a.selected.as_ref().is_some_and(|m| {
            a.downloaded
                .as_ref()
                .is_some_and(|(id, _)| m["id"] == id.as_str())
        });
        add(
            HISTORY_DEMO,
            box_rect(width - 210, height - 184, 182, 38),
            if matches!(a.active_task,Some(AccountTask::Demo(_))) {
                "Downloading…"
            } else if downloaded {
                "Open demo folder"
            } else {
                "Download demo"
            }
            .into(),
            a.selected.as_ref().is_some_and(|m| m["hasDemo"] == true) && !a.busy,
            false,
        );
    }
    let _ = content_width;
    controls
}
fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("—")
}
fn on_off(value: bool) -> String {
    if value { "On" } else { "Off" }.into()
}
fn account_control_ids() -> Vec<i32> {
    (3000..3005)
        .chain(3010..3012)
        .chain(3020..3027)
        .chain(3030..3038)
        .chain(3040..3044)
        .chain(3100..3108)
        .collect()
}
fn paint_account(dc: HDC, width: i32, height: i32, s: &UiState) {
    let mut p = PaintObjects::new();
    let a = &s.account;
    let title = if s.tab == LauncherTab::Settings {
        "Settings"
    } else {
        "Match history"
    };
    text_row(
        dc,
        &mut p,
        title,
        box_rect(28, 80, width - 56, 38),
        28,
        500,
        false,
        INK,
        SINGLE,
        0,
    );
    if s.tab == LauncherTab::Settings {
        let x = 260;
        let tw = width - x - 270;
        let mut row = |index: i32, title: &str, description: &str| {
            let y = 142 + index * 72;
            text_row(
                dc,
                &mut p,
                title,
                box_rect(x, y, tw, 26),
                18,
                500,
                false,
                INK,
                SINGLE,
                0,
            );
            text_row(
                dc,
                &mut p,
                description,
                box_rect(x, y + 28, tw, 32),
                14,
                400,
                false,
                MUTED,
                DT_WORDBREAK | DT_END_ELLIPSIS,
                0,
            );
        };
        match a.section {
            1 => {
                row(0, "Preferred region", "Choose the region closest to you.");
                row(1, "Website default mode", "In-game mode is chosen inside CS:GO.");
                row(2, "Party invites", "Allow B2G players to invite you.");
            }
            2 => {
                row(0, "Profile visibility", "Choose who can view your profile.");
                row(
                    1,
                    "Reduce motion",
                    "Minimize non-essential interface animation.",
                );
                row(
                    2,
                    "Match notifications",
                    "Ready checks, assignments and results.",
                );
                row(3, "Product updates", "Playtest and release announcements.");
            }
            3 => {
                row(
                    0,
                    "Debug console",
                    "Show live launcher output for this session.",
                );
                row(
                    1,
                    "Launcher log",
                    "Logs are saved even with the console hidden.",
                );
                row(
                    2,
                    "Game diagnostics",
                    "Inspect installation and integration status.",
                );
                row(
                    3,
                    "Repair game integration",
                    "Restore the B2G files in your game install.",
                );
            }
            4 => {
                row(0,"CS:GO",if s.setup.installation.as_ref().is_some_and(|i|i.ready){"Kept installed in your Steam library."}else{"Download the standalone legacy game."});
                row(1,"B2G integration","Repair launcher files without reinstalling CS:GO.");
                row(2,"Remove B2G","Remove the launcher and its game integration.");
                text_row(dc,&mut p,"CS:GO stays installed. Your settings, demos, equipped loadout and B2G items are kept. Download B2G from the site to install it again.",box_rect(x,370,width-x-40,70),15,400,false,MUTED,DT_WORDBREAK,0);
            }
            _ => {
                caption(
                    dc,
                    &mut p,
                    "PROFILE PICTURE",
                    box_rect(width - 246, 122, 210, 16),
                    MUTED,
                );
                profile_icon(
                    dc,
                    &mut p,
                    box_rect(width - 246, 142, 56, 56),
                    s.snapshot.as_ref(),
                );
                text_row(
                    dc,
                    &mut p,
                    "Shown on your Play card, on this PC.",
                    box_rect(width - 246, 200, 210, 18),
                    12,
                    400,
                    false,
                    MUTED,
                    SINGLE,
                    0,
                );
                let player = a.player.as_ref();
                text_row(
                    dc,
                    &mut p,
                    player
                        .map(|v| field(v, "displayName"))
                        .unwrap_or(if !s.paired {"Connect your account"} else if a.busy {"Loading account…"} else {"Account unavailable"}),
                    box_rect(x, 146, width - x - 40, 36),
                    24,
                    500,
                    false,
                    INK,
                    SINGLE,
                    0,
                );
                text_row(
                    dc,
                    &mut p,
                    player
                        .map(|v| field(v, "id"))
                        .unwrap_or(if !s.paired {"Use Connect Account below to sign in with Steam."} else {"Your account is connected. Refresh to load its details."}),
                    box_rect(x, 191, width - x - 40, 30),
                    14,
                    400,
                    false,
                    MUTED,
                    SINGLE,
                    0,
                );
                text_row(
                    dc,
                    &mut p,
                    "Your account, items and match results stay with your B2G profile.",
                    box_rect(x, 293, width - x - 40, 50),
                    16,
                    400,
                    false,
                    MUTED,
                    DT_WORDBREAK,
                    0,
                );
            }
        }
    } else {
        text_row(
            dc,
            &mut p,
            &if a.history_loaded {format!("{} completed matches",a.total)}else {String::new()},
            box_rect(28, 121, width - 56, 25),
            15,
            400,
            false,
            MUTED,
            SINGLE,
            0,
        );
        for (label, x, w) in [
            ("MAP / MODE", 40, 260),
            ("PLAYED (UTC)", width - 690, 150),
            ("RESULT", width - 522, 138),
            ("K / D", width - 366, 82),
            ("ADR", width - 258, 66),
            ("ELO", width - 150, 94),
        ] {
            text_row(
                dc,
                &mut p,
                label,
                box_rect(x, 147, w, 20),
                11,
                500,
                true,
                MUTED,
                SINGLE,
                0,
            );
        }
        if a.matches.is_empty() {
            text_row(
                dc,
                &mut p,
                if !s.paired {
                    "Connect your B2G account to view your matches."
                } else if a.busy {
                    "Loading your match history…"
                } else if a.history_loaded {
                    "No completed matches yet. Your results will appear here after a match ends."
                } else {
                    "Refresh to load your match history."
                },
                box_rect(40, 224, width - 80, 70),
                20,
                400,
                false,
                MUTED,
                DT_WORDBREAK,
                0,
            );
        }
        if a.total > 0 && !a.matches.is_empty() {
            text_row(
                dc,
                &mut p,
                &format!(
                    "{}–{} of {}",
                    a.offset + 1,
                    (a.offset + a.matches.len()).min(a.total),
                    a.total
                ),
                box_rect(268, height - 182, 220, 34),
                14,
                400,
                true,
                MUTED,
                SINGLE,
                0,
            );
        }
    }
    let status = a.error.as_deref().unwrap_or(if a.busy {
        match a.active_task {
            Some(AccountTask::Load)=>"Loading account preferences…",
            Some(AccountTask::Save(_))=>"Saving settings…",
            Some(AccountTask::History(_))=>"Loading match history…",
            Some(AccountTask::Details(_))=>"Loading match details…",
            Some(AccountTask::Demo(_))=>"Downloading and verifying demo…",
            Some(AccountTask::Diagnostics)=>"Reading game diagnostics…",
            Some(AccountTask::Repair)=>"Repairing game integration…",
            Some(AccountTask::Uninstall)=>"Removing B2G and restoring the original game launcher…",
            Some(AccountTask::Logout)=>"Disconnecting account…",
            None=>"Loading…",
        }
    } else if a.dirty() && s.tab == LauncherTab::Settings {
        "You have unsaved changes."
    } else {
        &a.notice
    });
    text_row(
        dc,
        &mut p,
        status,
        box_rect(28, height - 134, width - 56, 30),
        14,
        400,
        false,
        if a.error.is_some() { ERROR } else { MUTED },
        SINGLE,
        0,
    );
    for control in account_controls(width, height, s) {
        paint_account_button(dc, control.rect, control.id, s, false, false);
    }
}
fn paint_account_button(dc: HDC, r: BoxRect, id: i32, s: &UiState, pressed: bool, focused: bool) {
    // Labels and enabled state come from the same model as real Win32 controls.
    let Some(c) = account_controls(WINDOW_WIDTH, WINDOW_HEIGHT, s)
        .into_iter()
        .find(|c| c.id == id)
    else {
        return;
    };
    let mut p = PaintObjects::new();
    let primary = id == SETTINGS_SAVE;
    fill(
        dc,
        &mut p,
        r,
        if primary && c.enabled {
            BLUE
        } else if pressed || c.selected || s.hovered_button == Some(id) {
            INSET
        } else {
            PANEL
        },
    );
    if id >= HISTORY_ROW {
        if let Some(m) = s.account.matches.get((id - HISTORY_ROW) as usize) {
            let w = r.width();
            let x = r.left;
            let map = format!(
                "{}  ·  {}",
                field(m, "map"),
                if m["mode"] == "deathmatch" {
                    "DM"
                } else {
                    "5v5"
                }
            );
            let date = field(m, "playedAt")
                .get(..16)
                .unwrap_or(field(m, "playedAt"))
                .replace('T', " ");
            let result = format!("{}  {}", field(m, "outcome"), field(m, "score"));
            for (value, offset, width, color, mono) in [
                (map, 12, w - 662, INK, false),
                (date, w - 662, 150, MUTED, true),
                (
                    result,
                    w - 494,
                    140,
                    if m["outcome"] == "W" { GREEN } else { INK },
                    false,
                ),
                (
                    format!("{} / {}", m["kills"], m["deaths"]),
                    w - 338,
                    84,
                    INK,
                    true,
                ),
                (m["adr"].to_string(), w - 230, 70, MUTED, true),
                (
                    format!("{:+}", m["ratingDelta"].as_i64().unwrap_or(0)),
                    w - 122,
                    100,
                    INK,
                    true,
                ),
            ] {
                text_row(
                    dc,
                    &mut p,
                    &value,
                    box_rect(x + offset, r.top, width, r.height()),
                    14,
                    500,
                    mono,
                    color,
                    SINGLE,
                    0,
                );
            }
        }
    } else {
        let dropdown = matches!(id, SETTINGS_REGION | SETTINGS_MODE | SETTINGS_VISIBILITY);
        text_row(
            dc,
            &mut p,
            &c.label,
            box_rect(
                r.left + 8,
                r.top + 8,
                r.width() - if dropdown { 38 } else { 16 },
                r.height() - 16,
            ),
            14,
            600,
            false,
            if !c.enabled {
                MUTED
            } else if primary {
                BLUE_INK
            } else if id == SETTINGS_UNINSTALL {
                ERROR
            } else {
                INK
            },
            SINGLE | if id < 3005 { 0 } else { DT_CENTER },
            0,
        );
        if dropdown {
            icon(
                dc,
                box_rect(r.right - 26, r.top + (r.height() - 18) / 2, 18, 18),
                30,
                MUTED,
            );
        }
    }
    if focused || c.selected {
        unsafe {
            FrameRect(dc, &r.inset(1).native(), p.brush(BLUE));
        }
    }
}
fn create_account_controls(hwnd: HWND) {
    for id in account_control_ids() {
        unsafe {
            let child = CreateWindowExW(
                0,
                wide("BUTTON").as_ptr(),
                wide("").as_ptr(),
                WS_CHILD | WS_TABSTOP | BS_OWNERDRAW as u32,
                0,
                0,
                1,
                1,
                hwnd,
                id as usize as HMENU,
                GetModuleHandleW(ptr::null()),
                ptr::null(),
            );
            if !child.is_null() {
                SetWindowSubclass(child, Some(button_proc), id as usize, 0);
            }
        }
    }
}
fn sync_account_controls(hwnd: HWND) {
    let size = logical_client(hwnd);
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96) as i32;
    let controls = {
        let Ok(s) = state().lock() else {
            return;
        };
        account_controls(size.right, size.bottom, &s)
    };
    for id in account_control_ids() {
        unsafe {
            let child = GetDlgItem(hwnd, id);
            if child.is_null() {
                continue;
            }
            if let Some(c) = controls.iter().find(|c| c.id == id) {
                let r = c.rect;
                MoveWindow(
                    child,
                    r.left * dpi / 96,
                    r.top * dpi / 96,
                    r.width() * dpi / 96,
                    r.height() * dpi / 96,
                    0,
                );
                EnableWindow(child, i32::from(c.enabled));
                if trade_edit_text(hwnd, id) != c.label {
                    SetWindowTextW(child, wide(&c.label).as_ptr());
                }
                ShowWindow(child, SW_SHOWNOACTIVATE);
                InvalidateRect(child, ptr::null(), 0);
            } else {
                ShowWindow(child, SW_HIDE);
            }
        }
    }
}
fn account_command(hwnd: HWND, id: i32) {
    if id==SETTINGS_UNINSTALL {
        if !state().lock().is_ok_and(|s|!s.playing&&!s.account.busy&&!s.setup.installing&&!s.setup.preparing){return;}
        let answer=unsafe { MessageBoxW(hwnd,wide("Remove the B2G launcher and its game integration from this PC?\n\nCS:GO stays installed in Steam. Your settings, demos, equipped loadout, account and items are kept.\n\nThe launcher will close. Download B2G from play.back2go.net to install it again.").as_ptr(),wide("Uninstall B2G").as_ptr(),MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2) };
        if answer!=IDYES{return;}
        account_task(hwnd,AccountTask::Uninstall);
        return;
    }
    if id==SETTINGS_INSTALL {
        if state().lock().is_ok_and(|s| !s.playing&&!s.account.busy&&!s.setup.installing&&!s.setup.preparing&&!s.install_ready()) {
            setup_command(hwnd,SETUP_INSTALL);
        }
        return;
    }
    if matches!(id, SETTINGS_REGION | SETTINGS_MODE | SETTINGS_VISIBILITY) {
        account_dropdown(hwnd, id);
        return;
    }
    if id == HISTORY_DEMO {
        let path = state().lock().ok().and_then(|s| {
            s.account
                .downloaded
                .as_ref()
                .filter(|(id, _)| {
                    s.account
                        .selected
                        .as_ref()
                        .is_some_and(|m| m["id"] == id.as_str())
                })
                .map(|(_, path)| path.clone())
        });
        if let Some(path) = path {
            if let Some(parent) = path.parent() {
                open_url(&parent.to_string_lossy());
            }
            return;
        }
    }
    let mut task = None;
    let mut console = None;
    let mut avatar = None;
    let mut log = false;
    {
        let Ok(mut s) = state().lock() else {
            return;
        };
        let playing = s.playing;
        let a = &mut s.account;
        if (3000..3005).contains(&id) {
            a.section = id - 3000;
        } else if id == SETTINGS_CONSOLE {
            console = Some(!crate::console::visible());
        } else if id == SETTINGS_LOG {
            log = true;
        } else if id == SETTINGS_AVATAR {
            let current = crate::profile_icon();
            let index = crate::PROFILE_ICONS
                .iter()
                .position(|value| *value == current)
                .unwrap_or(0);
            avatar = Some(crate::PROFILE_ICONS[(index + 1) % crate::PROFILE_ICONS.len()]);
        } else if !a.busy {
            match id {
                SETTINGS_SAVE => {
                    if let Some(d) = &a.draft {
                        task = Some(AccountTask::Save(d.clone()));
                    }
                }
                SETTINGS_RESET => {
                    a.draft = a.saved.clone();
                    a.notice = "Changes discarded.".into();
                }
                SETTINGS_DIAGNOSTICS => task = Some(AccountTask::Diagnostics),
                SETTINGS_REPAIR if !playing => task = Some(AccountTask::Repair),
                SETTINGS_LOGOUT if !playing => task = Some(AccountTask::Logout),
                HISTORY_PREV => task = Some(AccountTask::History(a.offset.saturating_sub(8))),
                HISTORY_NEXT if a.offset + 8 < a.total => {
                    task = Some(AccountTask::History(a.offset + 8))
                }
                HISTORY_DETAILS => {
                    if let Some(m) = &a.selected {
                        task = Some(AccountTask::Details(field(m, "id").into()));
                    }
                }
                HISTORY_DEMO => {
                    if let Some(m) = &a.selected {
                        task = Some(AccountTask::Demo(m.clone()));
                    }
                }
                id if (HISTORY_ROW..HISTORY_ROW + 8).contains(&id) => {
                    a.selected = a.matches.get((id - HISTORY_ROW) as usize).cloned();
                }
                _ => {
                    if let Some(d) = &mut a.draft {
                        let cycle = |current: &mut String, values: &[&str]| {
                            let index = values
                                .iter()
                                .position(|v| *v == current.as_str())
                                .unwrap_or(0);
                            *current = values[(index + 1) % values.len()].into();
                        };
                        match id {
                            SETTINGS_REGION => cycle(
                                &mut d.region,
                                &["NA Central", "NA East", "NA West", "EU Central"],
                            ),
                            SETTINGS_MODE => {
                                cycle(&mut d.preferred_mode, &["competitive", "deathmatch"])
                            }
                            SETTINGS_VISIBILITY => {
                                cycle(&mut d.profile_visibility, &["public", "players", "private"])
                            }
                            SETTINGS_INVITES => d.allow_party_invites = !d.allow_party_invites,
                            SETTINGS_MOTION => d.reduced_motion = !d.reduced_motion,
                            SETTINGS_MATCH_NOTICE => d.match_notifications = !d.match_notifications,
                            SETTINGS_UPDATES => d.product_updates = !d.product_updates,
                            _ => {}
                        }
                    }
                }
            }
        }
    }
    if let Some(show) = console {
        if let Err(error) = crate::console::set_visible(show) {
            if let Ok(mut s) = state().lock() {
                s.account.error = Some(error);
            }
        }
    }
    if let Some(next) = avatar {
        let result = crate::set_profile_icon(next);
        if let Ok(mut s) = state().lock() {
            match result {
                Ok(()) => {
                    s.account.error = None;
                    s.account.notice = format!(
                        "Profile picture set to {}.",
                        crate::profile_icon_label(next).to_lowercase()
                    );
                }
                Err(error) => s.account.error = Some(error),
            }
        }
    }
    if log {
        if let Some(path) = crate::launcher_log_path() {
            open_url(&path.to_string_lossy());
        }
    }
    if let Some(task) = task {
        account_task(hwnd, task);
    }
    sync_controls(hwnd);
    unsafe {
        InvalidateRect(hwnd, ptr::null(), 0);
    }
}

fn account_dropdown(hwnd: HWND, id: i32) {
    let values: &[(&str, &str)] = match id {
        SETTINGS_REGION => &[
            ("NA Central", "NA Central"),
            ("NA East", "NA East"),
            ("NA West", "NA West"),
            ("EU Central", "EU Central"),
        ],
        SETTINGS_MODE => &[
            ("competitive", "Competitive 5v5"),
            ("deathmatch", "Deathmatch"),
        ],
        _ => &[
            ("public", "Public"),
            ("players", "Signed-in players"),
            ("private", "Private"),
        ],
    };
    let current = {
        let Ok(s) = state().lock() else {
            return;
        };
        if s.account.busy {
            return;
        }
        let Some(d) = &s.account.draft else {
            return;
        };
        match id {
            SETTINGS_REGION => d.region.clone(),
            SETTINGS_MODE => d.preferred_mode.clone(),
            _ => d.profile_visibility.clone(),
        }
    };
    let selected = unsafe {
        let menu = CreatePopupMenu();
        if menu.is_null() {
            return;
        }
        for (i, (value, label)) in values.iter().enumerate() {
            AppendMenuW(
                menu,
                MF_STRING | if *value == current { MF_CHECKED } else { 0 },
                4001 + i,
                wide(label).as_ptr(),
            );
        }
        let mut r: RECT = std::mem::zeroed();
        GetWindowRect(GetDlgItem(hwnd, id), &mut r);
        let selected = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTALIGN,
            r.right,
            r.bottom,
            0,
            hwnd,
            ptr::null(),
        );
        DestroyMenu(menu);
        selected
    };
    if let Some((value, _)) = selected
        .checked_sub(4001)
        .and_then(|i| values.get(i as usize))
    {
        if let Ok(mut s) = state().lock() {
            if let Some(d) = &mut s.account.draft {
                match id {
                    SETTINGS_REGION => d.region = (*value).into(),
                    SETTINGS_MODE => d.preferred_mode = (*value).into(),
                    _ => d.profile_visibility = (*value).into(),
                }
            }
        }
        sync_controls(hwnd);
        unsafe {
            InvalidateRect(hwnd, ptr::null(), 0);
        }
    }
}

fn show_account_details(hwnd: HWND) {
    let detail = {
        let Ok(mut s) = state().lock() else {
            return;
        };
        if !s.account.pending_details {
            return;
        }
        s.account.pending_details = false;
        s.account.details.clone()
    };
    if let Some(value) = detail {
        if let Some(diagnostics) = value["diagnostics"].as_str() {
            show_text_details(hwnd, "B2G game diagnostics", diagnostics);
            return;
        }
        let mut body = format!(
            "{} · {}\n{} · {}\nScore: {} – {}\n\n",
            field(&value, "map"),
            field(&value, "mode"),
            field(&value, "region"),
            field(&value, "endedAt"),
            value["score"]["alpha"],
            value["score"]["bravo"]
        );
        for team in ["alpha", "bravo", "ffa"] {
            if let Some(players) = value["teams"][team].as_array() {
                if !players.is_empty() {
                    body.push_str(&format!("{}\n", team.to_uppercase()));
                }
                for player in players {
                    body.push_str(&format!("{}   {} / {} / {}   ADR {}   KAST {}%   Elo {:+}\nOpening kills/deaths: {}/{} · Trades: {} · Clutches: {} · Flash assists: {} · Utility damage: {}\n\n",
                    field(player,"displayName"),player["kills"],player["deaths"],player["assists"],player["adr"],player["kast"],player["ratingDelta"].as_i64().unwrap_or(0),player["openingKills"],player["openingDeaths"],player["trades"],player["clutches"],player["flashAssists"],player["utilityDamage"]));
                }
            }
        }
        body.push_str(&format!(
            "Demo: {}\nMatch ID: {}",
            if value["demo"]["available"] == true {
                "Available — use Download demo in Match History."
            } else {
                "Not available"
            },
            field(&value, "id")
        ));
        show_text_details(hwnd, "B2G match details", &body);
    }
}

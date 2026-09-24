use super::*;

fn fixture() -> UiState {
    let mut s = render_tests::fixture();
    s.tab = LauncherTab::Settings;
    s.account.apply(AccountResult{window:0,epoch:0,data:Ok(AccountData::Player(serde_json::json!({
        "id":"6dcd25d0-1954-4d15-8497-fb37bdff48bd","displayName":"cubsfan49","region":"NA Central",
        "settings":{"preferredMode":"deathmatch","profileVisibility":"players","allowPartyInvites":true,
            "matchNotifications":true,"productUpdates":false,"reducedMotion":false}}),false))},0);
    s.account.matches=(0..8).map(|i|serde_json::json!({"id":format!("6dcd25d0-1954-4d15-8497-fb37bdff48b{i}"),
        "map":if i%3==0{"de_dust2"}else{"de_inferno"},"playedAt":"2026-09-07T18:43:00.000Z","mode":if i%3==0{"deathmatch"}else{"competitive"},
        "score":if i%3==0{"40 top frags"}else{"16–12"},"outcome":if i%2==0{"W"}else{"L"},"ratingDelta":if i%3==0{0}else{24},"kills":27,"deaths":16,"adr":92,"hasDemo":true})).collect();
    s.account.total = 37;
    s.account.history_loaded = true;
    s.account.selected = s.account.matches.first().cloned();
    s
}

#[test]
fn preserves_unsaved_preferences_and_rejects_stale_results() {
    let mut s = fixture();
    let mut a = s.account.clone();
    a.draft.as_mut().unwrap().region = "EU Central".into();
    a.apply(
        AccountResult {
            window: 0,
            epoch: 0,
            data: Ok(AccountData::Player(a.player.clone().unwrap(), false)),
        },
        0,
    );
    assert_eq!(a.draft.as_ref().unwrap().region, "EU Central");
    assert!(a.dirty());
    a.epoch = 2;
    a.busy = true;
    a.apply(
        AccountResult {
            window: 0,
            epoch: 1,
            data: Ok(AccountData::Notice("stale".into())),
        },
        0,
    );
    assert!(a.busy);
    assert_ne!(a.notice, "stale");
    s.account = a;
    s.tab = LauncherTab::History;
    s.tab = LauncherTab::Settings;
    assert!(s.account.dirty());
}

#[test]
fn automatic_trade_checks_leave_controls_live_and_ignore_old_responses() {
    let mut t = trading_state_tests::fixture();
    t.polling = true;
    let controls = trade_controls(1024, 664, &t);
    assert!(controls.iter().any(|c| c.enabled));
    assert!(!t.busy);
    let overview = t.overview.clone().unwrap();
    assert!(!apply_trade_poll(
        &mut t,
        0,
        TradeResult {
            window: 0,
            view: 0,
            mutation: false,
            data: Ok(TradeData::Overview(overview, None))
        }
    ));
    assert!(!t.polling);
    assert!(!t.busy);
    t.polling = true;
    t.request_epoch = 1;
    let mut stale = t.overview.clone().unwrap();
    stale.enabled = false;
    assert!(!apply_trade_poll(
        &mut t,
        0,
        TradeResult {
            window: 0,
            view: 0,
            mutation: false,
            data: Ok(TradeData::Overview(stale, None))
        }
    ));
    assert!(t.enabled());
    t.error=Some("Confirm this gift before sending.".into());
    assert!(apply_trade_poll(&mut t,1,TradeResult{window:0,view:0,mutation:false,data:Ok(TradeData::Seen("12".into()))}));
    assert_eq!(t.error.as_deref(),Some("Confirm this gift before sending."));
}

#[test]
fn account_surface_size_dpi_matrix() {
    load_fonts();
    for (w, h) in [(1024, 664), (1280, 780), (1360, 800)] {
        for dpi in [96, 120, 144, 192] {
            for page in 0..10 {
                if page>=6 && (w!=1024 || dpi!=120){continue;}
                let mut s = fixture();
                s.account.section = page.min(3);
                if page >= 4 {
                    s.tab = LauncherTab::History;
                }
                if page == 5 {
                    s.account.matches.clear();
                    s.account.total = 0;
                    s.account.selected = None;
                }
                match page {
                    6=>{s.account.matches.clear();s.account.selected=None;s.account.busy=true;s.account.active_task=Some(AccountTask::History(0));s.account.history_loaded=false;}
                    7=>{s.tab=LauncherTab::Settings;s.account.section=1;s.account.draft.as_mut().unwrap().allow_party_invites=false;s.account.error=Some("Could not reach B2G. Check your connection and use Refresh to retry. Your unsaved settings are preserved.".into());}
                    8=>{s=UiState::default();s.tab=LauncherTab::Settings;}
                    9=>{s.account.downloaded=Some((s.account.matches[0]["id"].as_str().unwrap().into(),std::path::PathBuf::from("C:/B2G/demos/fixture.dem")));s.account.notice="Demo verified and saved. Open its folder to use it in CS:GO.".into();}
                    _=>{}
                }
                for c in account_controls(w, h, &s) {
                    assert!(
                        c.rect.left >= 0
                            && c.rect.right <= w
                            && c.rect.top >= 73
                            && c.rect.bottom <= h - 134,
                        "{}",
                        c.id
                    );
                }
                let surface = Surface::new(w * dpi / 96, h * dpi / 96).unwrap();
                scale_dc(surface.dc, dpi as u32);
                paint_surface(surface.dc, w, h, &s);
                unsafe {
                    GdiFlush();
                }
                if let Some(directory) = std::env::var_os("B2G_RENDER_TEST_DIR") {
                    window_tests::save_native_render(
                        &directory,
                        &format!("account-{page}-{w}x{h}-{dpi}"),
                        &surface,
                    );
                }
            }
        }
    }
}

#[test]
fn game_installation_controls_cover_installed_missing_and_busy_states() {
    load_fonts();
    for (w,h) in [(1024,664),(1280,780)] {
        for dpi in [96,120,192] {
            for (name,ready,playing,uninstalling) in [("installed",true,false,false),("missing",false,false,false),("playing",true,true,false),("removing",true,false,true)] {
                let mut s=fixture();s.account.section=4;s.playing=playing;
                s.setup.installation=Some(crate::setup::InstallStatus{steam_available:true,ready,downloaded:0,total:0,detail:String::new()});
                if uninstalling {s.account.busy=true;s.account.active_task=Some(AccountTask::Uninstall);}
                let controls=account_controls(w,h,&s);
                assert_eq!(controls.iter().find(|c|c.id==SETTINGS_UNINSTALL).unwrap().enabled,!playing&&!uninstalling);
                assert_eq!(controls.iter().find(|c|c.id==SETTINGS_INSTALL).unwrap().enabled,!ready&&!playing&&!uninstalling);
                if uninstalling {assert!(s.account_blocks_play());assert!(!s.begin_play());}
                for c in &controls {assert!(account_control_ids().contains(&c.id));assert!(c.rect.bottom<=h-134&&c.rect.right<=w);}
                let surface=Surface::new(w*dpi/96,h*dpi/96).unwrap();scale_dc(surface.dc,dpi as u32);paint_surface(surface.dc,w,h,&s);
                if let Some(dir)=std::env::var_os("B2G_RENDER_TEST_DIR") {window_tests::save_native_render(&dir,&format!("game-install-{name}-{w}-{dpi}"),&surface);}
            }
        }
    }
}

#[test]
fn only_current_uninstall_completion_closes_the_launcher_and_blocks_play() {
    let mut s=fixture();
    s.account.epoch=5;
    for (window,epoch) in [(99,5),(0,4)] {
        s.account.apply(AccountResult{window,epoch,data:Ok(AccountData::UninstallStarted)},0);
        assert!(!s.account.uninstall_started);
    }
    s.account.apply(AccountResult{window:0,epoch:5,data:Ok(AccountData::UninstallStarted)},0);
    assert!(s.account.uninstall_started);
    assert!(s.account_blocks_play());
    assert!(!s.begin_play());
    s.account.section=4;
    assert!(!account_controls(1024,664,&s).iter().find(|c|c.id==SETTINGS_UNINSTALL).unwrap().enabled);
}

#[test]
fn native_settings_and_history_journey() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let _serial = NATIVE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut child = Command::new(std::env::current_exe().unwrap())
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .args([
            "--exact",
            "launcher_ui::windows::account_tests::native_account_child",
            "--ignored",
            "--nocapture",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() > deadline {
            child.kill().unwrap();
            panic!("Native account window stalled");
        }
        thread::sleep(std::time::Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

unsafe extern "system" fn fixture_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_CREATE {
        create_controls(hwnd);
        create_trade_controls(hwnd);
        create_account_controls(hwnd);
        sync_controls(hwnd);
        return 0;
    }
    unsafe { window_proc(hwnd, message, wparam, lparam) }
}
fn pump() {
    unsafe {
        let mut m: MSG = std::mem::zeroed();
        while PeekMessageW(&mut m, ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
    }
}
fn settled() {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        pump();
        if state()
            .lock()
            .is_ok_and(|s| !s.account.busy && s.account.deferred.is_none())
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Account worker stalled"
        );
        thread::sleep(std::time::Duration::from_millis(5));
    }
}
fn click(hwnd: HWND, id: i32) {
    unsafe {
        windows_sys::Win32::UI::Input::KeyboardAndMouse::SetActiveWindow(hwnd);
        let control = GetDlgItem(hwnd, id);
        assert_ne!(IsWindowVisible(control), 0, "Hidden control {id}");
        assert_ne!(IsWindowEnabled(control), 0, "Disabled control {id}");
        SendMessageW(control, BM_CLICK, 0, 0);
    }
    pump();
}
fn capture(hwnd: HWND, name: &str) {
    if let Some(dir) = std::env::var_os("B2G_RENDER_TEST_DIR") {
        unsafe {
            UpdateWindow(hwnd);
            let mut r: RECT = std::mem::zeroed();
            GetWindowRect(hwnd, &mut r);
            let surface = Surface::new(r.right - r.left, r.bottom - r.top).unwrap();
            assert_ne!(
                windows_sys::Win32::Storage::Xps::PrintWindow(hwnd, surface.dc, 0),
                0
            );
            GdiFlush();
            window_tests::save_native_render(&dir, name, &surface);
        }
    }
}

#[test]
#[ignore = "launched only by the account window watchdog"]
fn native_account_child() {
    use crate::trading::test_support::{Response, Server, set_connection};
    use std::sync::Arc;
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    load_fonts();
    let baseline = fixture();
    let remote = Arc::new(Mutex::new(baseline.account.player.clone().unwrap()));
    let response_player = remote.clone();
    let matches = baseline.account.matches.clone();
    let server = Server::new(move |request| {
        assert_eq!(request.bearer, "Bearer account-fixture");
        let mut player = response_player.lock().unwrap();
        let value = match request.path.as_str() {
            "/api/launcher/v1/account" => player.clone(),
            "/api/launcher/v1/account/settings" => {
                assert_eq!(request.method, "POST");
                player["settings"] = request.body.clone();
                player["region"] = request.body["region"].clone();
                player.clone()
            }
            path if path.starts_with("/api/launcher/v1/matches?") => {
                serde_json::json!({"entries":matches,"total":16})
            }
            path if path.starts_with("/api/launcher/v1/matches/") => {
                serde_json::json!({"id":matches[0]["id"],"map":"de_dust2","mode":"deathmatch","region":"NA Central","endedAt":"2026-09-07T18:43:00Z","score":{"alpha":40,"bravo":38},
                "teams":{"alpha":[],"bravo":[],"ffa":[{"displayName":"Account fixture","kills":27,"deaths":16,"assists":5,"adr":92,"kast":70,"ratingDelta":0,"openingKills":4,"openingDeaths":3,"trades":2,"clutches":1,"flashAssists":5,"utilityDamage":120}]},"demo":null})
            }
            _ => panic!("Unexpected native account request: {}", request.path),
        };
        Response {
            delay: std::time::Duration::from_millis(60),
            ..Response::okay(value)
        }
    });
    set_connection(Some(server.connection("account-fixture")));
    let mut initial = baseline;
    initial.account = AccountState::default();
    initial.tab = LauncherTab::Play;
    initial.trading.window = 88;
    initial.begin_play();
    initial.apply_event(UiEvent::GameReady);
    *state().lock().unwrap() = initial;
    events().lock().unwrap().clear();
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let class_name = wide("B2GNativeAccountFixture");
    let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(fixture_proc),
        hInstance: instance,
        lpszClassName: class_name.as_ptr(),
        ..unsafe { std::mem::zeroed() }
    };
    assert_ne!(unsafe { RegisterClassExW(&class) }, 0);
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name.as_ptr(),
            wide("B2G account fixture").as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            GetSystemMetrics(SM_XVIRTUALSCREEN) - 3000,
            GetSystemMetrics(SM_YVIRTUALSCREEN) - 3000,
            1280,
            780,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null(),
        )
    };
    assert!(!hwnd.is_null());
    unsafe {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        UpdateWindow(hwnd);
    }
    pump();
    click(hwnd, SETTINGS_TAB_ID);
    settled();
    assert!(state().lock().unwrap().account.draft.is_some());
    click(hwnd, SETTINGS_ACCOUNT + 1);
    click(hwnd, SETTINGS_INVITES);
    assert!(state().lock().unwrap().account.dirty());
    capture(hwnd, "native-settings-unsaved");
    click(hwnd, PLAY_TAB_ID);
    click(hwnd, SETTINGS_TAB_ID);
    assert!(state().lock().unwrap().account.dirty());
    click(hwnd, SETTINGS_SAVE);
    click(hwnd, HISTORY_TAB_ID);
    settled();
    assert!(
        !remote.lock().unwrap()["settings"]["allowPartyInvites"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(state().lock().unwrap().account.matches.len(), 8);
    assert!(!state().lock().unwrap().account.dirty());
    click(hwnd, HISTORY_NEXT);
    settled();
    assert_eq!(state().lock().unwrap().account.offset, 8);
    click(hwnd, HISTORY_ROW);
    capture(hwnd, "native-match-history");
    click(hwnd, HISTORY_DETAILS);
    settled();
    let detail = unsafe {
        FindWindowW(
            wide("B2GSessionDetails").as_ptr(),
            wide("B2G match details").as_ptr(),
        )
    };
    assert!(trade_edit_text(detail, DETAILS_EDIT).contains("Account fixture"));
    capture(detail, "native-match-details");
    assert_ne!(unsafe { IsWindow(detail) }, 0);
    unsafe {
        SendMessageW(detail, WM_CLOSE, 0, 0);
    }
    click(hwnd, SETTINGS_TAB_ID);
    click(hwnd, SETTINGS_ACCOUNT + 3);
    capture(hwnd, "native-settings-debug");
    assert_eq!(
        unsafe { IsWindowEnabled(GetDlgItem(hwnd, SETTINGS_REPAIR)) },
        0
    );
    {
        let s = state().lock().unwrap();
        assert!(s.playing && s.game_ready);
    }
    unsafe {
        DestroyWindow(hwnd);
        UnregisterClassW(class_name.as_ptr(), instance);
    }
    pump();
    set_connection(None);
}

#[test]
fn repair_and_disconnect_exclude_game_launch_until_completion() {
    for task in [AccountTask::Repair,AccountTask::Logout] {
        let mut s=fixture();s.playing=false;s.pairing=false;s.account.busy=true;s.account.active_task=Some(task);
        assert!(!s.begin_play());
        s.account.apply(AccountResult{window:0,epoch:0,data:Ok(AccountData::Notice("Finished".into()))},0);
        assert!(s.begin_play());
    }
}

#[test]
fn paired_account_read_and_failure_captures() {
    load_fonts();
    for kind in ["loading","failure","read-draft"] {
        let mut s=fixture();s.tab=LauncherTab::Settings;
        if kind!="read-draft" {s.account=AccountState::default();}
        else {s.account.section=1;s.account.draft.as_mut().unwrap().allow_party_invites=false;}
        if kind=="failure" {s.account.error=Some("Could not reach B2G. Check your connection and use Refresh to retry.".into());}
        else {s.account.busy=true;s.account.active_task=Some(AccountTask::Load);}
        let surface=Surface::new(1280,830).unwrap();scale_dc(surface.dc,120);paint_surface(surface.dc,1024,664,&s);
        if let Some(dir)=std::env::var_os("B2G_RENDER_TEST_DIR") {window_tests::save_native_render(&dir,&format!("paired-settings-{kind}"),&surface);}
    }
}

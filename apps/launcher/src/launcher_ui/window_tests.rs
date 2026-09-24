use super::*;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static DRAW_CALLBACKS: AtomicUsize = AtomicUsize::new(0);

// Run in a separate process so a Win32 reentrancy deadlock fails within a bound.
// The fixture uses an off-screen native window and synthetic account states.
// It never reads credentials, starts workers, contacts the API or launches a game.
#[test]
fn native_window_remains_responsive_during_control_updates() {
    let _serial=NATIVE_TEST_LOCK.lock().unwrap_or_else(|error|error.into_inner());
    let mut child = Command::new(std::env::current_exe().unwrap())
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .args([
            "--exact",
            "launcher_ui::windows::window_tests::native_window_child",
            "--ignored",
            "--nocapture",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(12);
    let mut timed_out = false;
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            timed_out = true;
            child.kill().unwrap();
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        !timed_out
            && output.status.success()
            && String::from_utf8_lossy(&output.stderr).contains("B2G_NATIVE_WINDOW_SMOKE_OK"),
        "Native window stalled or failed (timeout={timed_out}):\n{}\n{}",
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
        // Production startup ordering, with the network worker replaced by a
        // pending synthetic refresh that is completed through UI_EVENT below.
        create_controls(hwnd);
        state().lock().unwrap().begin_refresh();
        sync_controls(hwnd);
        return 0;
    }
    if message == WM_DRAWITEM {
        DRAW_CALLBACKS.fetch_add(1, Ordering::Relaxed);
    }
    unsafe { window_proc(hwnd, message, wparam, lparam) }
}

fn pump() {
    unsafe {
        let mut message: MSG = std::mem::zeroed();
        while PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

#[test]
#[ignore = "invoked in a child process by the native-window watchdog"]
fn native_window_child() {
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let first_paint_start = Instant::now();
    load_fonts();
    *state().lock().unwrap() = UiState::default();
    events().lock().unwrap().clear();
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let class_name = wide("B2GNativeWindowRegression");
    let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(fixture_proc),
        hInstance: instance,
        lpszClassName: class_name.as_ptr(),
        ..unsafe { std::mem::zeroed() }
    };
    assert_ne!(unsafe { RegisterClassExW(&class) }, 0);
    eprintln!("Creating native controls");
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name.as_ptr(),
            wide("B2G synthetic window test").as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            GetSystemMetrics(SM_XVIRTUALSCREEN) - 2500,
            GetSystemMetrics(SM_YVIRTUALSCREEN) - 2500,
            1360,
            840,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null(),
        )
    };
    assert!(!hwnd.is_null());
    eprintln!("Painting native controls");
    unsafe {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        UpdateWindow(hwnd);
    }
    pump();
    eprintln!(
        "B2G_FIRST_PAINT_MS={:.3}",
        first_paint_start.elapsed().as_secs_f64() * 1000.0
    );
    if let Ok(path) = std::env::var("B2G_BENCH_READY_FILE") {
        std::fs::write(path, "ready").unwrap();
        let until = Instant::now() + Duration::from_secs(4);
        while Instant::now() < until {
            pump();
            thread::sleep(Duration::from_millis(10));
        }
    }
    let resize_start = Instant::now();
    eprintln!("Completing bootstrap through Windows messages");
    post_event(
        hwnd,
        UiEvent::Refreshed(Ok(render_tests::fixture().snapshot.unwrap())),
    );
    pump();
    assert_eq!(state().lock().unwrap().primary_label(), "PLAY");
    for step in 0..8 {
        eprintln!("Updating controls {step}");
        {
            let mut state = state().lock().unwrap();
            state.playing = step % 2 == 0;
            state.refreshing = step % 2 == 0;
            state.game_ready = step % 3 == 0;
        }
        sync_controls(hwnd);
        unsafe {
            SetWindowPos(
                hwnd,
                ptr::null_mut(),
                0,
                0,
                1024 + step * 20,
                700,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            UpdateWindow(hwnd);
        }
        pump();
    }
    eprintln!(
        "B2G_RESIZE_8_MS={:.3}",
        resize_start.elapsed().as_secs_f64() * 1000.0
    );
    assert!(
        DRAW_CALLBACKS.load(Ordering::Relaxed) > 0,
        "No real owner-draw callbacks occurred"
    );
    *state().lock().unwrap() = render_tests::fixture();
    sync_controls(hwnd);
    unsafe {
        let window_dpi = GetDpiForWindow(hwnd).max(96) as i32;
        SetWindowPos(
            hwnd,
            ptr::null_mut(),
            0,
            0,
            1360 * window_dpi / 96,
            800 * window_dpi / 96,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
        let mut window: RECT = std::mem::zeroed();
        let mut client: RECT = std::mem::zeroed();
        GetWindowRect(hwnd, &mut window);
        GetClientRect(hwnd, &mut client);
        assert_eq!(
            (client.right, client.bottom),
            (window.right - window.left, window.bottom - window.top),
            "The old OS caption must not take client space"
        );
        let dpi = GetDpiForWindow(hwnd).max(96) as i32;
        for (x, y, expected) in [
            (1, 1, HTTOPLEFT),
            (400, 25, HTCLIENT),
            (400, 100, HTCLIENT),
        ] {
            let sx = window.left + x * dpi / 96;
            let sy = window.top + y * dpi / 96;
            let point = ((sx as u16 as u32) | ((sy as u16 as u32) << 16)) as LPARAM;
            assert_eq!(
                SendMessageW(hwnd, WM_NCHITTEST, 0, point),
                expected as LRESULT,
                "hit test {x},{y}"
            );
        }
        // Hosted Windows runners can clamp a window to the virtual desktop's
        // maximum tracking size. Test the actual native controls at either
        // responsive layout width, rather than assuming a 1360px client.
        for id in [PLAY_TAB_ID, TRADE_TAB_ID, HISTORY_TAB_ID, FRIENDS_TAB_ID, SETTINGS_TAB_ID, CLOSE_ID] {
            let mut button: RECT = std::mem::zeroed();
            assert_ne!(GetWindowRect(GetDlgItem(hwnd, id), &mut button), 0);
            let sx = (button.left + button.right) / 2;
            let sy = (button.top + button.bottom) / 2;
            let point = ((sx as u16 as u32) | ((sy as u16 as u32) << 16)) as LPARAM;
            assert_eq!(SendMessageW(hwnd, WM_NCHITTEST, 0, point), HTCLIENT as LRESULT, "tab/control {id} must remain clickable");
        }
        let mut settings: RECT = std::mem::zeroed();
        GetWindowRect(GetDlgItem(hwnd, SETTINGS_TAB_ID), &mut settings);
        let sx = settings.right + 8 * dpi / 96;
        let sy = (settings.top + settings.bottom) / 2;
        let point = ((sx as u16 as u32) | ((sy as u16 as u32) << 16)) as LPARAM;
        assert_eq!(SendMessageW(hwnd, WM_NCHITTEST, 0, point), HTCAPTION as LRESULT, "space after the tabs must drag the window");
        let primary = GetDlgItem(hwnd, PRIMARY_ID);
        assert_eq!(
            GetNextDlgTabItem(hwnd, primary, 0),
            GetDlgItem(hwnd, REFRESH_ID)
        );
        assert_eq!(IsWindowVisible(GetDlgItem(hwnd, UPDATE_ID)), 0);
        let mut visited = std::collections::HashSet::new();
        let mut cursor = primary;
        loop {
            visited.insert(cursor as usize);
            cursor = GetNextDlgTabItem(hwnd, cursor, 0);
            if cursor == primary {
                break;
            }
            assert!(visited.len() < 14);
        }
        assert_eq!(
            visited.len(),
            13,
            "Every visible home control is keyboard reachable"
        );
        if let Some(directory) = std::env::var_os("B2G_RENDER_TEST_DIR") {
            let surface = Surface::new(client.right, client.bottom).unwrap();
            assert_ne!(
                windows_sys::Win32::Storage::Xps::PrintWindow(hwnd, surface.dc, 0),
                0
            );
            for id in [
                PRIMARY_ID,
                REFRESH_ID,
                ACCOUNT_ID,
                DETAILS_ID,
                MINIMIZE_ID,
                MAXIMIZE_ID,
                CLOSE_ID,
                NEWS_ID,
            ] {
                let mut button: RECT = std::mem::zeroed();
                GetWindowRect(GetDlgItem(hwnd, id), &mut button);
                let color = GetPixel(
                    surface.dc,
                    button.right - window.left - 1,
                    button.bottom - window.top - 1,
                );
                assert_eq!(
                    color,
                    if id == DETAILS_ID { PANEL } else { BG },
                    "Native control {id} leaves an unpainted fractional-DPI edge"
                );
            }
            save_native_render(&directory, "native-window", &surface);
        }
        state().lock().unwrap().action_error = Some(crate::FACEIT_LAUNCH_BLOCK.into());
        sync_controls(hwnd);
        let mut help_name = [0u16; 64];
        let length = GetWindowTextW(GetDlgItem(hwnd, DETAILS_ID), help_name.as_mut_ptr(), help_name.len() as i32);
        assert_eq!(String::from_utf16_lossy(&help_name[..length as usize]), "&Launch help");
        assert!(details_text().starts_with(&format!("Launch help\n\n{}", crate::FACEIT_LAUNCH_BLOCK)));
        let details = show_details(hwnd);
        assert!(!details.is_null());
        assert_eq!(
            show_details(hwnd),
            details,
            "Reuse the existing details view"
        );
        let edit = GetDlgItem(details, DETAILS_EDIT);
        assert!(
            GetWindowTextLengthW(edit) > 1000,
            "Full history and recovery text is selectable"
        );
        assert_ne!(GetWindowLongPtrW(edit, GWL_STYLE) & WS_VSCROLL as isize, 0);
        assert!(
            SendMessageW(
                edit,
                windows_sys::Win32::UI::Controls::EM_GETLINECOUNT,
                0,
                0
            ) > 20
        );
        if let Some(directory) = std::env::var_os("B2G_RENDER_TEST_DIR") {
            GetWindowRect(details, &mut window);
            let surface =
                Surface::new(window.right - window.left, window.bottom - window.top).unwrap();
            assert_ne!(
                windows_sys::Win32::Storage::Xps::PrintWindow(details, surface.dc, 0),
                0
            );
            save_native_render(&directory, "native-details", &surface);
        }
        SendMessageW(edit, windows_sys::Win32::UI::Controls::EM_LINESCROLL, 0, 30);
        assert!(
            SendMessageW(
                edit,
                windows_sys::Win32::UI::Controls::EM_GETFIRSTVISIBLELINE,
                0,
                0
            ) > 0
        );
        SendMessageW(details, WM_COMMAND, DETAILS_CLOSE as usize, 0);
        assert_eq!(IsWindow(details), 0);
        // Minimize the already off-screen, nonactivating fixture via its actual button.
        SendMessageW(GetDlgItem(hwnd, MINIMIZE_ID), BM_CLICK, 0, 0);
        assert_ne!(IsIconic(hwnd), 0);
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        // Verify maximized geometry on a hidden HWND: no fullscreen fixture is shown.
        ShowWindow(hwnd, SW_HIDE);
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_MAXIMIZE as isize);
        let mut calc: NCCALCSIZE_PARAMS = std::mem::zeroed();
        SendMessageW(
            hwnd,
            WM_NCCALCSIZE,
            1,
            (&mut calc as *mut NCCALCSIZE_PARAMS) as LPARAM,
        );
        let mut monitor: MONITORINFO = std::mem::zeroed();
        monitor.cbSize = size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(
            MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
            &mut monitor,
        );
        assert_eq!(
            (
                calc.rgrc[0].left,
                calc.rgrc[0].top,
                calc.rgrc[0].right,
                calc.rgrc[0].bottom
            ),
            (
                monitor.rcWork.left,
                monitor.rcWork.top,
                monitor.rcWork.right,
                monitor.rcWork.bottom
            )
        );
        sync_controls(hwnd);
        let mut name = [0u16; 32];
        GetWindowTextW(GetDlgItem(hwnd, MAXIMIZE_ID), name.as_mut_ptr(), 32);
        assert!(String::from_utf16_lossy(&name).starts_with("Restore"));
        SetWindowLongPtrW(hwnd, GWL_STYLE, style);
        sync_controls(hwnd);
        GetWindowTextW(GetDlgItem(hwnd, MAXIMIZE_ID), name.as_mut_ptr(), 32);
        assert!(String::from_utf16_lossy(&name).starts_with("Maximize"));
        // Suggested DPI rectangles are applied without activating the window.
        // Keep the synthetic suggestion within the hosted desktop's supported
        // tracking size; Windows otherwise clamps a 1700px test rectangle.
        let actual_dpi = GetDpiForWindow(hwnd).max(96) as i32;
        let suggested = RECT {
            left: -2400,
            top: -2400,
            right: -2400 + 1024 * actual_dpi / 96,
            bottom: -2400 + 664 * actual_dpi / 96,
        };
        SendMessageW(
            hwnd,
            WM_DPICHANGED,
            144 | ((144 as usize) << 16),
            (&suggested as *const RECT) as LPARAM,
        );
        GetWindowRect(hwnd, &mut window);
        assert_eq!(
            (window.left, window.top, window.right, window.bottom),
            (suggested.left, suggested.top, suggested.right, suggested.bottom)
        );
    }
    check_available_monitors(hwnd);
    state().lock().unwrap().playing = false;
    eprintln!("Closing native window");
    unsafe {
        SendMessageW(GetDlgItem(hwnd, CLOSE_ID), BM_CLICK, 0, 0);
    }
    pump();
    assert_eq!(unsafe { IsWindow(hwnd) }, 0);
    unsafe {
        UnregisterClassW(class_name.as_ptr(), instance);
    }
    eprintln!("B2G_NATIVE_WINDOW_SMOKE_OK");
}

pub(super) fn save_native_render(directory: &std::ffi::OsStr, name: &str, surface: &Surface) {
    unsafe {
        GdiFlush();
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(surface.bits, (surface.width * surface.height * 4) as usize)
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    let mut data = Vec::with_capacity(8 + bytes.len());
    data.extend_from_slice(&(surface.width as u32).to_le_bytes());
    data.extend_from_slice(&(surface.height as u32).to_le_bytes());
    data.extend_from_slice(bytes);
    std::fs::write(directory.join(format!("{name}.bgra")), data).unwrap();
}

// Observe actual available monitor/DPI transitions with a hidden, nonactivating
// fixture. This does not capture desktop pixels or move an owner's application.
unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _dc: HDC,
    rect: *mut RECT,
    data: LPARAM,
) -> i32 {
    unsafe {
        (*(data as *mut Vec<(HMONITOR, RECT)>)).push((monitor, *rect));
    }
    1
}
fn check_available_monitors(hwnd: HWND) {
    unsafe {
        assert_eq!(IsWindowVisible(hwnd), 0);
        let mut monitors: Vec<(HMONITOR, RECT)> = vec![];
        assert_ne!(
            EnumDisplayMonitors(
                ptr::null_mut(),
                ptr::null(),
                Some(collect_monitor),
                (&mut monitors as *mut Vec<(HMONITOR, RECT)>) as LPARAM
            ),
            0
        );
        let mut scales = vec![];
        for (monitor, rect) in &monitors {
            let mut xdpi = 0;
            let mut ydpi = 0;
            assert_eq!(
                GetDpiForMonitor(*monitor, MDT_EFFECTIVE_DPI, &mut xdpi, &mut ydpi),
                0
            );
            let width = 1024 * xdpi as i32 / 96;
            let height = 664 * ydpi as i32 / 96;
            assert_ne!(
                SetWindowPos(
                    hwnd,
                    ptr::null_mut(),
                    (rect.left + rect.right - width) / 2,
                    (rect.top + rect.bottom - height) / 2,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_NOZORDER
                ),
                0
            );
            pump();
            assert_eq!(IsWindowVisible(hwnd), 0);
            assert_eq!(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), *monitor);
            assert_eq!(GetDpiForWindow(hwnd), xdpi);
            let mut button: RECT = std::mem::zeroed();
            GetWindowRect(GetDlgItem(hwnd, PRIMARY_ID), &mut button);
            assert_eq!(
                (button.right - button.left, button.bottom - button.top),
                (288 * xdpi as i32 / 96, 64 * ydpi as i32 / 96)
            );
            scales.push(xdpi);
        }
        eprintln!(
            "B2G_AVAILABLE_MONITORS={} B2G_ACTUAL_DPI={scales:?}",
            monitors.len()
        );
    }
}

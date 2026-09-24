// A small native, selectable and scrollable view for copy condensed on the home.
// No browser/runtime, blocking work, or account requests are needed to open it.
const DETAILS_EDIT: i32 = 1101;
const DETAILS_CLOSE: i32 = 1102;

unsafe extern "system" fn details_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        match message {
            WM_CREATE => {
                let instance = GetModuleHandleW(ptr::null());
                let edit = CreateWindowExW(
                    0,
                    wide("EDIT").as_ptr(),
                    wide("").as_ptr(),
                    WS_CHILD
                        | WS_VISIBLE
                        | WS_TABSTOP
                        | WS_VSCROLL
                        | ES_MULTILINE as u32
                        | ES_READONLY as u32
                        | ES_AUTOVSCROLL as u32,
                    0,
                    0,
                    1,
                    1,
                    hwnd,
                    DETAILS_EDIT as usize as HMENU,
                    instance,
                    ptr::null(),
                );
                SetWindowSubclass(edit, Some(details_edit_proc), DETAILS_EDIT as usize, 0);
                CreateWindowExW(
                    0,
                    wide("BUTTON").as_ptr(),
                    wide("&Close").as_ptr(),
                    WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
                    0,
                    0,
                    1,
                    1,
                    hwnd,
                    DETAILS_CLOSE as usize as HMENU,
                    instance,
                    ptr::null(),
                );
                0
            }
            WM_SIZE | WM_DPICHANGED => {
                if message == WM_DPICHANGED {
                    let r = &*(lparam as *const RECT);
                    SetWindowPos(
                        hwnd,
                        ptr::null_mut(),
                        r.left,
                        r.top,
                        r.right - r.left,
                        r.bottom - r.top,
                        SWP_NOACTIVATE | SWP_NOZORDER,
                    );
                }
                let dpi = GetDpiForWindow(hwnd).max(96) as i32;
                let mut r: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut r);
                let pad = 20 * dpi / 96;
                let button_h = 32 * dpi / 96;
                let button_w = 100 * dpi / 96;
                MoveWindow(
                    GetDlgItem(hwnd, DETAILS_EDIT),
                    pad,
                    pad,
                    (r.right - 2 * pad).max(1),
                    (r.bottom - 3 * pad - button_h).max(1),
                    1,
                );
                MoveWindow(
                    GetDlgItem(hwnd, DETAILS_CLOSE),
                    r.right - pad - button_w,
                    r.bottom - pad - button_h,
                    button_w,
                    button_h,
                    1,
                );
                let mut p = PaintObjects::new();
                let font = p.typeface(18 * dpi / 96, 400, false);
                for id in [DETAILS_EDIT, DETAILS_CLOSE] {
                    SendMessageW(GetDlgItem(hwnd, id), WM_SETFONT, font as usize, 1);
                }
                0
            }
            WM_GETMINMAXINFO => {
                let info = &mut *(lparam as *mut MINMAXINFO);
                let dpi = GetDpiForWindow(hwnd).max(96) as i32;
                info.ptMinTrackSize.x = 420 * dpi / 96;
                info.ptMinTrackSize.y = 320 * dpi / 96;
                0
            }
            WM_CTLCOLORSTATIC | WM_CTLCOLOREDIT => {
                SetTextColor(wparam as HDC, INK);
                SetBkColor(wparam as HDC, PANEL);
                static BRUSH: OnceLock<usize> = OnceLock::new();
                *BRUSH.get_or_init(|| CreateSolidBrush(PANEL) as usize) as LRESULT
            }
            WM_ERASEBKGND => {
                let mut r: RECT = std::mem::zeroed();
                GetClientRect(hwnd, &mut r);
                let mut p = PaintObjects::new();
                FillRect(wparam as HDC, &r, p.brush(PANEL));
                1
            }
            WM_COMMAND if matches!((wparam & 0xffff) as i32, DETAILS_CLOSE | 1 | 2) => {
                DestroyWindow(hwnd);
                0
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }
}

unsafe extern "system" fn details_edit_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    unsafe {
        if message == WM_KEYDOWN
            && wparam == 65
            && windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState(17) < 0
        {
            SendMessageW(hwnd, windows_sys::Win32::UI::Controls::EM_SETSEL, 0, -1);
            return 0;
        }
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(details_edit_proc), id);
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}

fn show_details(owner: HWND) -> HWND {
    let title = if state().lock().is_ok_and(|s| s.has_launch_error()) {
        "B2G · Launch help"
    } else {
        "B2G · News, release notes & session details"
    };
    show_text_details(owner,title,&details_text())
}
fn show_text_details(owner: HWND,title:&str,body:&str) -> HWND {
    static WINDOW: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    use std::sync::atomic::Ordering;
    let value = body.replace('\n', "\r\n");
    unsafe {
        let previous = WINDOW.load(Ordering::Relaxed) as HWND;
        let mut process_id=0;
        GetWindowThreadProcessId(previous,&mut process_id);
        if IsWindow(previous) != 0 && GetWindow(previous,GW_OWNER)==owner
            && process_id==windows_sys::Win32::System::Threading::GetCurrentProcessId() {
            SetWindowTextW(previous,wide(title).as_ptr());
            SetWindowTextW(GetDlgItem(previous, DETAILS_EDIT), wide(&value).as_ptr());
            ShowWindow(previous, SW_SHOWNORMAL);
            return previous;
        }
        let class_name = wide("B2GSessionDetails");
        let instance = GetModuleHandleW(ptr::null());
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(details_proc),
            hInstance: instance,
            hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
            lpszClassName: class_name.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassExW(&class);
        let mut r: RECT = std::mem::zeroed();
        GetWindowRect(owner, &mut r);
        let dpi = GetDpiForWindow(owner).max(96) as i32;
        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            class_name.as_ptr(),
            wide(title).as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
            r.left + 40 * dpi / 96,
            r.top + 40 * dpi / 96,
            720 * dpi / 96,
            560 * dpi / 96,
            owner,
            ptr::null_mut(),
            instance,
            ptr::null(),
        );
        if !hwnd.is_null() {
            WINDOW.store(hwnd as usize, Ordering::Relaxed);
            SetWindowTextW(GetDlgItem(hwnd, DETAILS_EDIT), wide(&value).as_ptr());
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            UpdateWindow(hwnd);
        }
        hwnd
    }
}

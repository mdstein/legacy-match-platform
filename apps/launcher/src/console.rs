//! GUI launches never allocate a console. CLI calls retain their redirected
//! handles and attach to the invoking terminal only when needed.
#[cfg(windows)]
use windows_sys::Win32::System::Console::*;

pub fn initialize_console(command: Option<&str>) {
    #[cfg(windows)]
    if !matches!(
        command,
        None | Some("ui" | "protocol" | "apply-update" | "debug-console")
    ) {
        unsafe {
            let output = GetStdHandle(STD_OUTPUT_HANDLE);
            let error = GetStdHandle(STD_ERROR_HANDLE);
            AttachConsole(ATTACH_PARENT_PROCESS);
            // AttachConsole may replace inherited redirection. Keep valid
            // pipes/files supplied by the caller for CLI and release scripts.
            for (kind, handle) in [(STD_OUTPUT_HANDLE, output), (STD_ERROR_HANDLE, error)] {
                if !handle.is_null()
                    && handle != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE
                {
                    SetStdHandle(kind, handle);
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(windows)]
static DEBUGGER: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

#[cfg(windows)]
pub(crate) fn visible() -> bool {
    let Ok(mut child) = DEBUGGER.lock() else {
        return false;
    };
    if child
        .as_mut()
        .is_some_and(|child| child.try_wait().ok().flatten().is_some())
    {
        *child = None;
    }
    child.is_some()
}

#[cfg(windows)]
pub(crate) fn set_visible(show: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let active = visible();
    if show == active {
        return Ok(());
    }
    let mut child = DEBUGGER.lock().map_err(|_| "The debug console is busy.")?;
    if show {
        // The console belongs to a separate log viewer. Closing its X cannot
        // terminate the launcher, disconnect the game, or touch the user's shell.
        let path = crate::launcher_log_path().ok_or("The launcher log folder is unavailable.")?;
        *child = Some(
            std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
                .args([
                    "debug-console",
                    "--parent-pid",
                    &std::process::id().to_string(),
                    "--log",
                ])
                .arg(path)
                .creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP)
                .spawn()
                .map_err(|e| format!("Could not open the debug console: {e}"))?,
        );
        crate::log_launcher_event("debug console opened");
    } else if let Some(mut process) = child.take() {
        if process.try_wait().map_err(|e| e.to_string())?.is_none() {
            process
                .kill()
                .map_err(|e| format!("Could not close the debug console: {e}"))?;
        }
        let _ = process.wait();
    }
    Ok(())
}

#[cfg(windows)]
pub fn run_debug_console(parent_pid: u32, path: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::*;
    if parent_pid == 0 || parent_pid == std::process::id() {
        return Err("Invalid debug-console parent.".into());
    }
    let parent = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, parent_pid) };
    if parent.is_null() {
        return Ok(());
    }
    let result = (|| {
        if unsafe { AllocConsole() } == 0 {
            return Err("Windows could not create the debug console.".into());
        }
        use std::os::windows::io::AsRawHandle;
        let console_output = std::fs::OpenOptions::new()
            .write(true)
            .open("CONOUT$")
            .map_err(|e| e.to_string())?;
        unsafe {
            SetStdHandle(STD_OUTPUT_HANDLE, console_output.as_raw_handle());
            SetStdHandle(STD_ERROR_HANDLE, console_output.as_raw_handle());
        }
        let title: Vec<u16> = "B2G Debug Console — close this window to stop viewing logs"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            SetConsoleTitleW(title.as_ptr());
        }
        let mut output = std::io::stdout();
        let _ = writeln!(
            output,
            "B2G launcher log · closing this window leaves B2G running\n{}\n",
            path.display()
        );
        let mut position = None;
        while unsafe { WaitForSingleObject(parent, 200) } == WAIT_TIMEOUT {
            if let Ok(mut file) = std::fs::File::open(path) {
                let length = file.metadata().map_err(|e| e.to_string())?.len();
                let offset = position
                    .filter(|old| *old <= length)
                    .unwrap_or(length.saturating_sub(64 * 1024));
                file.seek(SeekFrom::Start(offset))
                    .map_err(|e| e.to_string())?;
                let mut bytes = vec![];
                file.take(1024 * 1024)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                position = Some(offset + bytes.len() as u64);
                if output.write_all(&bytes).is_err() {
                    break;
                }
                let _ = output.flush();
            }
        }
        Ok(())
    })();
    unsafe {
        CloseHandle(parent);
        FreeConsole();
    }
    result
}

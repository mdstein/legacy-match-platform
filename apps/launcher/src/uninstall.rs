//! Remove B2G's managed integration and per-user launcher, never Steam's game.
#[cfg(windows)]
use super::*;

#[cfg(windows)]
fn ordinary_path(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_attributes() & 0x400 != 0 => {
                return Err(format!(
                    "Cannot uninstall through a linked folder: {}.",
                    ancestor.display()
                ));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.to_string());
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(windows)]
fn integration_root(report: &DoctorReport) -> Result<Option<PathBuf>, String> {
    let Some(root) = report.game_root.as_ref().map(PathBuf::from) else {
        return Ok(None);
    };
    ordinary_path(&root)?;
    let backup = root.join("csgo.exe.b2g-original");
    if backup.is_file() {
        for relative in [
            "csgo.exe",
            "csgo.exe.b2g-original",
            "csgo_gc/csgo_gc.dll",
            "csgo_gc/config.txt",
            "csgo_gc/LICENSE.csgo-gc",
            "csgo_gc/B2G-PROVENANCE.md",
            "csgo_gc/b2g_owned_manifest.txt",
            "csgo_gc/csgo_gc.dll.b2g-original",
            "csgo_gc/config.txt.b2g-original",
        ] {
            ordinary_path(&root.join(relative))?;
        }
        require_game_stopped(&root)?;
        uninstall_gc_for_root(&root, true)?;
        Ok(Some(root))
    } else if root.join("csgo_gc/B2G-PROVENANCE.md").exists()
        || file_has_sha256(&root.join("csgo.exe"), GC_CLIENT_WRAPPER_SHA256)
    {
        Err("The original CS:GO launcher backup is missing. Repair or verify the game before removing B2G.".into())
    } else {
        Ok(None)
    }
}

pub(crate) fn begin() -> Result<(), String> {
    #[cfg(not(windows))]
    {
        Err("B2G uninstall is supported on Windows.".into())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let game = integration_root(&discover())?;
        let installed = install(true)?;
        ordinary_path(&installed)?;
        if running_game_process_ids(&installed)?
            .iter()
            .any(|id| *id != std::process::id())
        {
            return Err("Close other B2G launcher windows, then retry uninstall.".into());
        }
        let expected = if installed.is_file() {
            sha256_bytes(&fs::read(&installed).map_err(|e| e.to_string())?)
        } else {
            String::new()
        };
        let temp = env::temp_dir();
        ordinary_path(&temp)?;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let stem = format!("b2g-uninstall-{}-{nonce}", std::process::id());
        let script = temp.join(format!("{stem}.ps1"));
        let ready = temp.join(format!("{stem}.ready"));
        ordinary_path(&script)?;
        ordinary_path(&ready)?;
        // Unique, exclusively created handoffs cannot reuse an earlier confirmation.
        use std::io::Write;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&script)
            .and_then(|mut file| file.write_all(include_bytes!("uninstall.ps1")))
            .map_err(|e| e.to_string())?;
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.0);
            }
        }
        let cleanup = Cleanup(script.clone());
        let powershell = env::var_os("SystemRoot")
            .map(PathBuf::from)
            .ok_or("Windows system directory is unavailable.")?
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let make_command = || {
            let mut command = Command::new(&powershell);
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-WindowStyle",
                    "Hidden",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&script)
                .env("B2G_UNINSTALL_PARENT", std::process::id().to_string())
                .env("B2G_UNINSTALL_SHA256", &expected)
                .env("B2G_UNINSTALL_READY", &ready)
                .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
            command
        };
        let preflight = make_command()
            .arg("-CheckOnly")
            .output()
            .map_err(|e| e.to_string())?;
        if !preflight.status.success() {
            let error = String::from_utf8_lossy(&preflight.stderr)
                .trim()
                .to_string();
            return Err(format!(
                "B2G removal could not be prepared. {}",
                if error.is_empty() {
                    "Close other launcher windows and retry."
                } else {
                    &error
                }
            ));
        }
        let mut helper = make_command()
            .spawn()
            .map_err(|e| format!("Could not start the B2G removal helper: {e}"))?;
        // The helper waits for successful game recovery and process exit.
        if let Some(root) = game {
            if let Err(error) = uninstall_gc_for_root(&root, false) {
                let _ = helper.kill();
                return Err(error);
            }
        }
        if let Err(error) = fs::write(&ready, b"ready") {
            let _ = helper.kill();
            return Err(error.to_string());
        }
        // The helper owns its script once the ready marker is published.
        std::mem::forget(cleanup);
        log_launcher_event(
            "uninstall: game integration removed; closing launcher to finish per-user cleanup",
        );
        Ok(())
    }
}

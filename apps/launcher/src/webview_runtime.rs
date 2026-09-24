//! Install the shared Microsoft runtime only on machines that do not have it.
//! The launcher remains one executable; the full browser is not bundled.
use std::{
    fs,
    io::Read,
    os::windows::process::CommandExt,
    process::Command,
    time::{Duration, Instant},
};

pub(crate) fn ensure() -> Result<(), String> {
    if tauri::webview_version().is_ok() {
        return Ok(());
    }
    crate::log_launcher_event("ui: installing the missing Microsoft WebView2 runtime");
    let folder = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .ok_or("Windows could not locate the B2G setup folder.")?
        .join("B2G/runtime-setup");
    fs::create_dir_all(&folder).map_err(|e| format!("Could not prepare interface setup: {e}"))?;
    let path = folder.join(format!(
        "MicrosoftEdgeWebview2Setup-{}.exe",
        crate::trading::request_uuid()?
    ));
    let result = (|| -> Result<(), String> {
        let agent = ureq::Agent::config_builder()
            .max_redirects(5)
            .timeout_global(Some(Duration::from_secs(60)))
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .provider(ureq::tls::TlsProvider::NativeTls)
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .new_agent();
        let mut response=agent.get("https://go.microsoft.com/fwlink/p/?LinkId=2124703").call()
            .map_err(|_|"B2G needs Microsoft WebView2 for its interface. Connect to the internet and reopen B2G to finish setup.".to_string())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let bytes = std::io::copy(
            &mut response.body_mut().as_reader().take(8 * 1024 * 1024 + 1),
            &mut file,
        )
        .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if bytes == 0 || bytes > 8 * 1024 * 1024 {
            return Err(
                "The interface installer download was incomplete. Reopen B2G to retry.".into(),
            );
        }
        // Verify both the Windows trust chain and the Microsoft publisher.
        // The downloaded path is an environment value, never shell code.
        let script = "$s=Get-AuthenticodeSignature -LiteralPath $env:B2G_WEBVIEW_SETUP; if($s.Status -eq 'Valid' -and $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -eq 'Microsoft Corporation'){exit 0}; exit 1";
        let verified = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .env("B2G_WEBVIEW_SETUP", &path)
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if !verified.success() {
            return Err(
                "Windows could not verify Microsoft's interface installer. Reopen B2G to retry."
                    .into(),
            );
        }
        // Microsoft's progress UI stays visible during this first-time install.
        let mut installer = Command::new(&path)
            .arg("/install")
            .spawn()
            .map_err(|e| format!("Could not start interface setup: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(600);
        loop {
            if tauri::webview_version().is_ok() {
                return Ok(());
            }
            if let Some(exit) = installer.try_wait().map_err(|e| e.to_string())? {
                if !exit.success() {
                    return Err("Microsoft WebView2 setup did not finish. Reopen B2G to retry, or finish WebView2 installation in Windows.".into());
                }
            }
            if Instant::now() >= deadline {
                return Err("Interface setup is still finishing. Complete Microsoft WebView2 setup, then reopen B2G.".into());
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    })();
    let _ = fs::remove_file(&path);
    result
}

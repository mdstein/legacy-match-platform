//! Read Steam's installation state without patching an incomplete download.
use super::*;

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallStatus {
    pub steam_available: bool,
    pub ready: bool,
    pub downloaded: u64,
    pub total: u64,
    pub detail: String,
}

pub(crate) fn manifest_ready(contents: &str) -> bool {
    // StateFlags 4 is fully installed. Missing flags are accepted for older
    // imported manifests, provided executable/version checks also pass.
    let flags = vdf_value(contents, "StateFlags").and_then(|s| s.parse::<u64>().ok());
    let number = |key| vdf_value(contents, key).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    flags.is_none_or(|flags| flags == 4)
        && number("BytesDownloaded") >= number("BytesToDownload")
        && number("BytesStaged") >= number("BytesToStage")
}

pub(crate) fn status() -> InstallStatus {
    status_from_report(discover())
}

pub(super) fn status_from_report(report: DoctorReport) -> InstallStatus {
    // App 730's public branch is CS2. Its completed download is not progress
    // towards the standalone CS:GO installation launched by the Install action.
    let is_csgo = report.app_id.as_deref() == Some(STANDALONE_APP_ID)
        || report.beta_key.as_deref() == Some("csgo_legacy");
    let contents = report.app_manifest.as_ref().filter(|_| is_csgo).and_then(|p| fs::read_to_string(p).ok()).unwrap_or_default();
    let number = |key| vdf_value(&contents, key).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    InstallStatus {
        steam_available: report.steam_executable.is_some(),
        ready: report.legacy_ready,
        downloaded: number("BytesDownloaded"),
        total: number("BytesToDownload"),
        detail: report.blocking_reason.unwrap_or_else(|| "CS:GO is installed and ready.".into()),
    }
}

pub(crate) fn begin_install() -> Result<(), String> {
    #[cfg(windows)] {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let steam = discover().steam_executable;
        let target = if steam.is_some() { "steam://install/4465480" } else { "https://store.steampowered.com/about/" };
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), wide(target).as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
        if result as isize <= 32 { return Err("Steam could not open. Start Steam, then choose Install again.".into()); }
        Ok(())
    }
    #[cfg(not(windows))] { Err("Installation is supported on Windows.".into()) }
}

#[cfg(windows)]
pub(crate) fn registered_steam_root()->Option<PathBuf>{
    use windows_sys::Win32::System::Registry::*;
    let wide=|s:&str|s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut buffer=[0u16;2048];let mut bytes=std::mem::size_of_val(&buffer) as u32;
    let result=unsafe{RegGetValueW(HKEY_CURRENT_USER,wide("Software\\Valve\\Steam").as_ptr(),wide("SteamPath").as_ptr(),RRF_RT_REG_SZ,std::ptr::null_mut(),buffer.as_mut_ptr().cast(),&mut bytes)};
    if result!=0{return None;}
    let length=buffer.iter().position(|c|*c==0)?;
    let path=PathBuf::from(String::from_utf16(&buffer[..length]).ok()?);
    path.is_absolute().then_some(path)
}

#[cfg(windows)]
pub(crate) fn install_shortcut(target:&Path)->Result<(),String>{
    use std::os::windows::process::CommandExt;
    let appdata=env::var_os("APPDATA").map(PathBuf::from).ok_or("APPDATA is unavailable")?;
    let shortcut=appdata.join("Microsoft/Windows/Start Menu/Programs/B2G Launcher.lnk");
    // Paths are process environment values, never interpolated as shell code.
    let script="$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut($env:B2G_SETUP_SHORTCUT); $shortcut.TargetPath=$env:B2G_SETUP_TARGET; $shortcut.Arguments='ui'; $shortcut.WorkingDirectory=[IO.Path]::GetDirectoryName($env:B2G_SETUP_TARGET); $shortcut.Description='B2G CS:GO Launcher'; $shortcut.Save()";
    let output=Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-WindowStyle","Hidden","-Command",script])
        .env("B2G_SETUP_TARGET",target).env("B2G_SETUP_SHORTCUT",shortcut)
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW).output().map_err(|e|e.to_string())?;
    if !output.status.success(){return Err("Windows could not create the B2G shortcut.".into());}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_download_and_staging_cannot_be_patched() {
        assert!(!manifest_ready("\"StateFlags\" \"1026\"\n\"BytesDownloaded\" \"10\"\n\"BytesToDownload\" \"100\""));
        assert!(!manifest_ready("\"StateFlags\" \"4\"\n\"BytesStaged\" \"10\"\n\"BytesToStage\" \"100\""));
        assert!(manifest_ready("\"StateFlags\" \"4\"\n\"BytesDownloaded\" \"100\"\n\"BytesToDownload\" \"100\""));
        assert!(!manifest_ready("\"StateFlags\" \"6\""));
    }
}

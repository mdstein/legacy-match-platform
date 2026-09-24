#![cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    env, fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn per_user_cleanup_removes_only_b2g_and_refuses_a_changed_executable() {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let powershell = PathBuf::from(env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    for mode in ["remove", "changed"] {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let fixture =
            env::temp_dir().join(format!("b2g-helper-test-{}-{nonce}", std::process::id()));
        fs::create_dir(&fixture).unwrap();
        let result = Command::new(&powershell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(source.join("tests/uninstall-helper.ps1"))
            .env("B2G_UNINSTALL_FIXTURE", &fixture)
            .env("B2G_UNINSTALL_TEST_MODE", mode)
            .env("B2G_UNINSTALL_SOURCE", source.join("src/uninstall.ps1"))
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{mode}: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        fs::remove_dir_all(fixture).unwrap();
    }
}

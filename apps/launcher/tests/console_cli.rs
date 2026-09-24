#![cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

#[test]
fn executable_is_a_gui_app_and_cli_redirection_still_works() {
    let path = env!("CARGO_BIN_EXE_b2g-launcher");
    let bytes = std::fs::read(path).unwrap();
    let pe = u32::from_le_bytes(bytes[0x3c..0x40].try_into().unwrap()) as usize;
    assert_eq!(&bytes[pe..pe + 4], b"PE\0\0");
    // Subsystem is at the same offset in PE32 and PE32+ optional headers.
    assert_eq!(
        u16::from_le_bytes(bytes[pe + 24 + 68..pe + 24 + 70].try_into().unwrap()),
        2,
        "GUI startup must not allocate a console"
    );
    let output = Command::new(path).arg("--help").output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("B2G Launcher"));
}

#[test]
fn debug_console_is_an_independent_process_and_exits_with_its_parent() {
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    // Isolated fixture parent and log. No credentials, real launcher, or game.
    let mut parent = Command::new("powershell")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.artifacts/tests");
    std::fs::create_dir_all(&root).unwrap();
    let log = root.join(format!("console-{}.log", std::process::id()));
    std::fs::write(&log, "B2G isolated console lifecycle fixture\n").unwrap();
    let mut viewer = Command::new(env!("CARGO_BIN_EXE_b2g-launcher"))
        .args([
            "debug-console",
            "--parent-pid",
            &parent.id().to_string(),
            "--log",
        ])
        .arg(&log)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert!(
        viewer.try_wait().unwrap().is_none(),
        "Debug viewer must run independently"
    );
    parent.kill().unwrap();
    parent.wait().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if let Some(status) = viewer.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if std::time::Instant::now() > deadline {
            viewer.kill().unwrap();
            panic!("Debug viewer outlived its parent");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    std::fs::remove_file(log).unwrap();
}

use std::process::Command;

#[test]
fn version_reports_the_built_executable_without_starting_the_launcher() {
    for argument in ["version", "--version", "-V"] {
        let output = Command::new(env!("CARGO_BIN_EXE_b2g-launcher"))
            .arg(argument)
            .output()
            .expect("version command should run");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            format!("B2G Launcher {}", env!("CARGO_PKG_VERSION"))
        );
        assert!(output.stderr.is_empty());
    }
}

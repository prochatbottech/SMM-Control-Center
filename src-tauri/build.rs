use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    // Guard: Prevent compiling a release binary without built frontend assets
    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        let dist_index = Path::new("../dist/index.html");
        if !dist_index.exists() {
            panic!(
                "\n\n[ERROR] Frontend build not found at '../dist/index.html'!\n\
                 Before compiling release, please run:\n\
                   pnpm run build\n\
                 or use 'pnpm tauri build' (which builds frontend automatically).\n\n"
            );
        }
    }

    declare_common_controls_dependency();

    tauri_build::build();
}

/// Test binaries link `rfd`/`muda` (pulled in by the dialog plugin), which import
/// `TaskDialogIndirect` from `comctl32.dll`. Without an activation context that
/// requests comctl32 v6, Windows loads v5 and the process dies with
/// STATUS_ENTRYPOINT_NOT_FOUND before the test harness starts. The app binary
/// gets the dependency from `tauri-build`'s resource file; test binaries need it
/// declared explicitly. A manifest *dependency* is additive, so repeating it for
/// the app target is harmless.
fn declare_common_controls_dependency() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }

    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}

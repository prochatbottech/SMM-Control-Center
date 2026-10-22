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

    tauri_build::build();
}

fn main() {
    tauri_build::build();

    // `tauri_build` links the compiled Windows resource (icon + manifest
    // declaring the Common-Controls v6 dependency) into bin targets only
    // (`cargo:rustc-link-arg-bins`). Test binaries — especially the lib's
    // own unittest binary — don't get it and crash at startup with
    // STATUS_ENTRYPOINT_NOT_FOUND, because code pulled in via the lib
    // (e.g. rfd/tauri-plugin-dialog) imports `TaskDialogIndirect`, which
    // exists only in comctl32 v6.
    //
    // Toolchain split: GNU ld tolerates duplicate resource sections, so on
    // gnu we link the resource into EVERY linkable target (libtest included
    // — `rustc-link-arg-tests` only covers tests/ targets, not libtest).
    // On MSVC, cvtres is fatal on duplicate VERSION resources, so restrict
    // the extra link to tests/ targets — bins keep only tauri_build's copy.
    // (`cargo test` on Windows requires the gnu toolchain anyway.)
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    for name in ["libresource.a", "resource.res", "resource.lib"] {
        let path = format!("{out_dir}/{name}");
        if std::path::Path::new(&path).exists() {
            let key = if target_env == "msvc" {
                "cargo:rustc-link-arg-tests"
            } else {
                "cargo:rustc-link-arg"
            };
            println!("{key}={path}");
            break;
        }
    }
}

fn main() {
    tauri_build::build();

    // `tauri_build` links the compiled Windows resource (icon + manifest
    // declaring the Common-Controls v6 dependency) into bin targets only
    // (`cargo:rustc-link-arg-bins`). Test binaries — especially the lib's
    // own unittest binary — don't get it and crash at startup with
    // STATUS_ENTRYPOINT_NOT_FOUND, because code pulled in via the lib
    // (e.g. rfd/tauri-plugin-dialog) imports `TaskDialogIndirect`, which
    // exists only in comctl32 v6. Link the same resource into every
    // linkable target so `cargo test` works. Duplicate resource entries
    // in bins are harmless.
    let out_dir = std::env::var("OUT_DIR").unwrap();
    for name in ["libresource.a", "resource.res", "resource.lib"] {
        let path = format!("{out_dir}/{name}");
        if std::path::Path::new(&path).exists() {
            println!("cargo:rustc-link-arg={path}");
            break;
        }
    }
}

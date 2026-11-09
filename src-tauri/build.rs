fn main() {
    // `tauri dev` runs the exe straight from target/<profile>, where the bundle
    // resources aren't placed. Copy the sideloaded ConPTY next to it so dev runs
    // use the same ConPTY as the installed app.
    if let Ok(out) = std::env::var("OUT_DIR") {
        if let Some(profile_dir) = std::path::Path::new(&out).ancestors().nth(3) {
            for f in ["conpty.dll", "OpenConsole.exe"] {
                let _ = std::fs::copy(std::path::Path::new("conpty").join(f), profile_dir.join(f));
            }
        }
    }
    println!("cargo:rerun-if-changed=conpty");
    tauri_build::build()
}

fn main() {
    // Autogenerate `allow-<command>` / `deny-<command>` permissions for the
    // app's own Tauri commands so `capabilities/default.json` can reference
    // them as bare identifiers (e.g. "allow-server-health").
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "daemon_token",
            "pick_folder",
            "open_file",
            "reveal_in_folder",
            "get_prefs",
            "node_available",
            "open_web",
            "quit_app",
            "server_health",
            "server_managed",
            "set_prefs",
            "spawn_server",
            "stop_server",
            "validate_repo_root",
            "validate_workspace",
            "list_dir",
            "create_dir",
        ])),
    )
    .expect("failed to run tauri-build")
}

// Dae Captain — Tauri backend (thin client).
//
// This binary is deliberately thin: it owns a window (the dynamic island),
// manages the Daedalus Node server as a sidecar child process, and stores
// small app preferences. ALL agent/engine logic lives in the Node server;
// the UI talks to it over HTTP on 127.0.0.1:3080.
//
// Dependencies are intentionally minimal (tauri + serde only) so the build
// stays light and auditable.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct AppState {
    /// Child process handle when THIS app spawned the server.
    server_child: Mutex<Option<Child>>,
    /// True when the running server was spawned by us (so we may stop it).
    server_managed: Mutex<bool>,
    /// daemon.json path we wrote (for CLI `daedalus status`/`stop` interop).
    daemon_json: Mutex<Option<PathBuf>>,
}

// ---------------------------------------------------------------------------
// Preferences (plain JSON in the app data dir — non-secret only; API keys
// always live in the server's ~/.daedalus store via the settings API)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Prefs {
    repo_root: String,
    workspace_root: String,
    recent_workspaces: Vec<String>,
    server_host: String,
    server_port: u16,
    /// "ask" | "keep" | "stop" — what to do with our sidecar on quit.
    keep_alive: String,
    /// Dae Captain v2 Fase 8: pill resting corner — "top-center" (default),
    /// "top-left", "top-right", "bottom-left" or "bottom-right".
    #[serde(default = "default_island_corner")]
    island_corner: String,
    /// Dae Captain v2 Fase 8: pill notification mode — "pulse" (default),
    /// "sound" or "off".
    #[serde(default = "default_notify_mode")]
    notify_mode: String,
}

fn default_island_corner() -> String {
    "top-center".to_string()
}

fn default_notify_mode() -> String {
    "pulse".to_string()
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            repo_root: String::new(),
            workspace_root: String::new(),
            recent_workspaces: Vec::new(),
            server_host: "127.0.0.1".to_string(),
            server_port: 3080,
            keep_alive: "ask".to_string(),
            island_corner: default_island_corner(),
            notify_mode: default_notify_mode(),
        }
    }
}

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("dae-captain");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir prefs: {e}"))?;
    Ok(dir.join("prefs.json"))
}

#[tauri::command]
fn get_prefs(app: AppHandle) -> Result<Prefs, String> {    let path = prefs_path(&app)?;
    if !path.exists() {
        return Ok(Prefs::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read prefs: {e}"))?;
    let mut prefs: Prefs = serde_json::from_str(&raw).map_err(|e| format!("parse prefs: {e}"))?;
    if prefs.server_host.is_empty() {
        prefs.server_host = "127.0.0.1".to_string();
    }
    if prefs.server_port == 0 {
        prefs.server_port = 3080;
    }
    if prefs.keep_alive.is_empty() {
        prefs.keep_alive = "ask".to_string();
    }
    Ok(prefs)
}

/// Position the island window at a screen corner (Dae Captain v2 Fase 8,
/// Settings → Pill → Posisi). `corner` is one of "top-center" (default),
/// "top-left", "top-right", "bottom-left", "bottom-right"; `expanded`
/// tells which window size is currently live (pill 480x76 vs panel
/// 480x640) so a bottom corner anchors the right edge. The choice is
/// persisted in prefs.json so the pill rests there across restarts.
/// NOTE: args are single words — the tauri macro maps multi-word arg
/// names to camelCase, which bit us before (see AGENTS.md).
#[tauri::command]
fn position_island(app: AppHandle, corner: String, expanded: bool) -> Result<String, String> {
    let corner = corner.trim().to_lowercase();
    const CORNERS: &[&str] = &["top-center", "top-left", "top-right", "bottom-left", "bottom-right"];
    if !CORNERS.contains(&corner.as_str()) {
        return Err(format!("unknown corner: {corner} (expected one of {})", CORNERS.join("|")));
    }
    // Persist the preference (validated above).
    {
        let mut prefs = get_prefs(app.clone())?;
        prefs.island_corner = corner.clone();
        set_prefs(app.clone(), prefs)?;
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let monitor = window
        .primary_monitor()
        .map_err(|e| format!("primary_monitor: {e}"))?
        .ok_or_else(|| "no primary monitor".to_string())?;
    let msize = monitor.size();
    let mpos = monitor.position();
    let scale = monitor.scale_factor();
    // Logical window sizes mirror ui/app.js COMPACT/EXPANDED.
    let (lw, lh): (f64, f64) = if expanded { (480.0, 640.0) } else { (480.0, 76.0) };
    let win_w = (lw * scale) as i32;
    let win_h = (lh * scale) as i32;
    let margin = (8.0 * scale) as i32;
    let x = match corner.as_str() {
        "top-left" | "bottom-left" => mpos.x + margin,
        "top-right" | "bottom-right" => mpos.x + msize.width as i32 - win_w - margin,
        _ => mpos.x + ((msize.width as i32 - win_w) / 2),
    };
    let y = match corner.as_str() {
        "top-center" | "top-left" | "top-right" => mpos.y + margin,
        _ => mpos.y + msize.height as i32 - win_h - margin,
    };
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
        .map_err(|e| format!("set_position: {e}"))?;
    Ok(corner)
}

/// Read the local daemon token from ~/.daedalus/daemon.json.
/// The server generates this on first start; sensitive endpoints (approve,
/// cancel) require it as `Authorization: Bearer <token>`.

/// Open a native folder picker dialog. Returns the selected path, or None
/// if the user cancelled.
#[tauri::command]
fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_title("Pilih folder workspace")
        .blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
fn daemon_token() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("tidak bisa menemukan home directory")?;
    let path = home.join(".daedalus").join("daemon.json");
    let raw = fs::read_to_string(&path).map_err(|e| format!("baca daemon.json: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse daemon.json: {e}"))?;
    v.get("token")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or("token tidak ada di daemon.json".to_string())
}

#[tauri::command]
fn set_prefs(app: AppHandle, prefs: Prefs) -> Result<(), String> {
    if prefs.keep_alive != "ask" && prefs.keep_alive != "keep" && prefs.keep_alive != "stop" {
        return Err("keep_alive must be ask|keep|stop".to_string());
    }
    if prefs.server_port == 0 {
        return Err("invalid server_port".to_string());
    }
    let path = prefs_path(&app)?;
    let raw = serde_json::to_string_pretty(&prefs).map_err(|e| format!("encode prefs: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write prefs: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Server health — dependency-free raw TCP check (no HTTP client crate)
// ---------------------------------------------------------------------------

/// True when something accepts TCP on host:port (healthy or not).
fn port_in_use(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    let socket_addr: std::net::SocketAddr = match addr.parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&socket_addr, Duration::from_millis(800)).is_ok()
}

fn tcp_get_ok(host: &str, port: u16, path: &str) -> bool {
    let addr = format!("{host}:{port}");
    let socket_addr: std::net::SocketAddr = match addr.parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&socket_addr, Duration::from_millis(800)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// Raw-TCP HTTP GET that returns the response body (for /health JSON).
/// std-only like tcp_get_ok; the body may exceed one read, so read to end.
fn http_get_body(host: &str, port: u16, path: &str) -> Option<String> {
    let addr = format!("{host}:{port}");
    let socket_addr: std::net::SocketAddr = addr.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&socket_addr, Duration::from_millis(800)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let body_start = text.find("\r\n\r\n")? + 4;
    Some(text[body_start..].to_string())
}

#[derive(Serialize)]
struct HealthInfo {
    healthy: bool,
    url: String,
    /// Workspace the server is anchored to (from /health), if reachable.
    /// The UI uses it to detect "healthy but serving another workspace".
    workspace_root: Option<String>,
}

#[tauri::command]
fn server_health(app: AppHandle) -> Result<HealthInfo, String> {
    let prefs = get_prefs(app)?;
    let url = format!("http://{}:{}", prefs.server_host, prefs.server_port);
    let healthy = tcp_get_ok(&prefs.server_host, prefs.server_port, "/health");
    let workspace_root = if healthy {
        http_get_body(&prefs.server_host, prefs.server_port, "/health")
            .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
            .and_then(|v| {
                v.get("workspace_root")?
                    .as_str()
                    .map(|s| s.to_string())
            })
    } else {
        None
    };
    Ok(HealthInfo {
        healthy,
        url,
        workspace_root,
    })
}

#[tauri::command]
fn node_available() -> Result<bool, String> {
    Ok(Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false))
}

// ---------------------------------------------------------------------------
// Path validation (every picker/input in the UI resolves to a working control)
// ---------------------------------------------------------------------------

#[tauri::command]
fn validate_repo_root(path: String) -> Result<bool, String> {
    let root = Path::new(&path);
    Ok(root.join("server/src/main.ts").is_file() && root.join("cli/src/index.ts").is_file())
}

#[tauri::command]
fn validate_workspace(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_dir())
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
}

/// List a workspace directory (for "Scan Directory"). Sorted dirs-first,
/// capped at 200 entries — a readout, not a file manager.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = fs::read_dir(&path)
        .map_err(|e| format!("read dir: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    entries.truncate(200);
    Ok(entries)
}

/// Create a workspace directory (and parents). Returns false when it
/// already existed — never an error for that.
#[tauri::command]
fn create_dir(path: String) -> Result<bool, String> {
    if Path::new(&path).exists() {
        return Ok(false);
    }
    fs::create_dir_all(&path).map_err(|e| format!("create dir: {e}"))?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle
//
// Spawns the EXACT server entry the CLI itself spawns
// (`node --experimental-strip-types <repo>/server/src/main.ts`, see
// cli/src/launcher.ts `defaultSpawnServer`), so `cli/src/index.ts` is never
// modified and stays usable for the thesis demo.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SpawnInfo {
    started: bool,
    pid: Option<u32>,
    url: String,
    log_path: String,
}

/// Resolve the daemon home the same way the CLI does:
/// DAEDALUS_HOME env (absolute) wins, otherwise <workspace>/.daedalus.
fn daemon_home(workspace: &str) -> PathBuf {
    if let Ok(home) = std::env::var("DAEDALUS_HOME") {
        let p = PathBuf::from(&home);
        if p.is_absolute() {
            return p;
        }
        return Path::new(workspace).join(home);
    }
    Path::new(workspace).join(".daedalus")
}

fn iso_now() -> String {
    // Seconds since epoch rendered as ISO-8601 without external crates.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 1970-01-01T00:00:00Z + secs — formatted via a tiny civil-date calc.
    let days = secs / 86400;
    let rem = secs % 86400;
    let (y, m, d) = civil_from_days(days as i64);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

// Howard Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[tauri::command]
fn spawn_server(
    app: AppHandle,
    state: State<AppState>,
    repo_root: String,
    workspace: String,
) -> Result<SpawnInfo, String> {
    let prefs = get_prefs(app.clone())?;
    let host = if prefs.server_host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        prefs.server_host.clone()
    };
    let port = if prefs.server_port == 0 { 3080 } else { prefs.server_port };
    let url = format!("http://{host}:{port}");

    if tcp_get_ok(&host, port, "/health") {
        return Ok(SpawnInfo {
            started: false,
            pid: None,
            url,
            log_path: String::new(),
        });
    }

    // Something accepts TCP on the port but isn't a healthy Daedalus server
    // (zombie process, another app). Spawning now would just crash with
    // EADDRINUSE — say so clearly instead.
    if port_in_use(&host, port) {
        return Err(format!(
            "port {port} is already in use by another process (not a healthy Daedalus server); stop it first, then retry"
        ));
    }

    let server_main = Path::new(&repo_root).join("server/src/main.ts");
    if !server_main.is_file() {
        return Err(format!(
            "server entry not found: {} (is this the daedalus repo root?)",
            server_main.display()
        ));
    }
    if !Path::new(&workspace).is_dir() {
        return Err(format!("workspace is not a directory: {workspace}"));
    }

    let home = daemon_home(&workspace);
    fs::create_dir_all(&home).map_err(|e| format!("mkdir daemon home: {e}"))?;
    let log_path = home.join("dae-captain-server.log");
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open log: {e}"))?;
    let log_err = log_file.try_clone().map_err(|e| format!("clone log: {e}"))?;

    let mut child = Command::new("node")
        .arg("--experimental-strip-types")
        .arg(&server_main)
        .env("DAEDALUS_HOST", &host)
        .env("DAEDALUS_PORT", port.to_string())
        .env("DAEDALUS_WORKSPACE", &workspace)
        .stdin(Stdio::null())
        .stdout(log_file)
        .stderr(log_err)
        .spawn()
        .map_err(|e| format!("spawn node server: {e} (is node on PATH?)"))?;
    let pid = child.id();

    // Write daemon.json in the exact shape the CLI writes, so
    // `daedalus status` / `daedalus stop` interoperate with our sidecar.
    let daemon_json_path = home.join("daemon.json");
    let state_doc = serde_json::json!({
        "pid": pid,
        "host": host,
        "port": port,
        "started_at": iso_now(),
        "server_url": url,
        "workspace": workspace,
    });
    fs::write(
        &daemon_json_path,
        serde_json::to_string_pretty(&state_doc).unwrap(),
    )
    .map_err(|e| format!("write daemon.json: {e}"))?;

    // Wait for health (the CLI waits up to 5s; we allow a little more for
    // first-run type stripping).
    let deadline = Instant::now() + Duration::from_secs(12);
    let mut healthy = false;
    while Instant::now() < deadline {
        if tcp_get_ok(&host, port, "/health") {
            healthy = true;
            break;
        }
        // If the child already exited, fail fast with a useful error.
        if let Ok(Some(status)) = child.try_wait() {
            let _ = fs::remove_file(&daemon_json_path);
            return Err(format!(
                "server exited during startup (code {status}); see {}",
                log_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    if !healthy {
        let _ = child.kill();
        let _ = fs::remove_file(&daemon_json_path);
        return Err(format!(
            "server did not become healthy at {url} within 12s; see {}",
            log_path.display()
        ));
    }

    *state.server_child.lock().unwrap() = Some(child);
    *state.server_managed.lock().unwrap() = true;
    *state.daemon_json.lock().unwrap() = Some(daemon_json_path);

    Ok(SpawnInfo {
        started: true,
        pid: Some(pid),
        url,
        log_path: log_path.display().to_string(),
    })
}

#[tauri::command]
fn stop_server(state: State<AppState>) -> Result<bool, String> {
    let mut stopped = false;
    if *state.server_managed.lock().unwrap() {
        if let Some(mut child) = state.server_child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
            stopped = true;
        }
        *state.server_managed.lock().unwrap() = false;
    }
    if let Some(path) = state.daemon_json.lock().unwrap().take() {
        let _ = fs::remove_file(path);
    }
    Ok(stopped)
}

#[tauri::command]
fn server_managed(state: State<AppState>) -> Result<bool, String> {
    Ok(*state.server_managed.lock().unwrap())
}

// ---------------------------------------------------------------------------
// Desktop integration (std-only; no extra crates)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct CompositorInfo {
    wayland: bool,
    session_type: String,
    desktop: String,
    /// Honest note: true layer-shell pinning needs native integration
    /// (gtk-layer-shell); v1 uses a borderless always-on-top panel.
    layer_shell_pinned: bool,
}

#[tauri::command]
fn compositor_info() -> CompositorInfo {
    let session_type =
        std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".to_string());
    let wayland = std::env::var("WAYLAND_DISPLAY").is_ok() || session_type == "wayland";
    CompositorInfo {
        wayland,
        session_type,
        desktop: std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_else(|_| "unknown".to_string()),
        layer_shell_pinned: false,
    }
}

/// Open a URL in the default browser. Restricted to our own local server so
/// the control can't be repurposed as a generic launcher.
#[tauri::command]
fn open_web(url: String) -> Result<(), String> {
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
        return Err("open_web only allows local daedalus URLs".to_string());
    }
    Command::new("xdg-open")
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("xdg-open failed: {e}"))?;
    Ok(())
}

/// Open a file with the OS default application.
/// Only allows files inside the current workspace root (validated by caller).
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    // Basic safety: must be an absolute path, no null bytes
    if !path.starts_with('/') || path.contains('\0') {
        return Err("open_file requires an absolute path".to_string());
    }
    Command::new("xdg-open")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("xdg-open failed: {e}"))?;
    Ok(())
}

/// Reveal a file in the system file manager (select it).
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("reveal_in_folder requires an absolute path".to_string());
    }
    // Try file manager with --select, fall back to opening parent dir
    let parent = std::path::Path::new(&path).parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    // xdg-open doesn't support --select; try common file managers
    for fm in ["nautilus", "dolphin", "thunar", "pcmanfm"] {
        if Command::new(fm).arg("--select").arg(&path)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().is_ok() {
            return Ok(());
        }
    }
    // Fallback: open parent directory
    Command::new("xdg-open")
        .arg(&parent)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("xdg-open failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            // Global hotkey Ctrl+Shift+D (Fase 6): summon the island from
            // anywhere. The handler shows + focuses the window and emits
            // `dae-captain-hotkey`; the frontend toggles pill <-> chat.
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("dae-captain-hotkey", ());
                        }
                    }
                })
                .build(),
        )
        .manage(AppState {
            server_child: Mutex::new(None),
            server_managed: Mutex::new(false),
            daemon_json: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_prefs,
            set_prefs,
            daemon_token,
            pick_folder,
            position_island,
            server_health,
            server_managed,
            node_available,
            validate_repo_root,
            validate_workspace,
            list_dir,
            create_dir,
            spawn_server,
            stop_server,
            compositor_info,
            open_web,
            open_file,
            reveal_in_folder,
            quit_app,
        ])
        .setup(|app| {
            // Global hotkey: Ctrl+Shift+D summons the island from anywhere.
            // Registration failure (e.g. another app grabbed it) is logged,
            // never fatal — the pill and chat keep working without it.
            if let Err(e) = app.global_shortcut().register("Control+Shift+D") {
                eprintln!("global hotkey Ctrl+Shift+D not registered: {e}");
            }
            // Position the island top-center of the primary monitor.
            // NOTE (honest): this is a borderless always-on-top panel, NOT a
            // true zwlr_layer_shell surface. True compositor pinning needs
            // native layer-shell integration (gtk-layer-shell or
            // wayland-protocols-wlr + smithay-client-toolkit) — documented
            // as a follow-up in BUILD.md. On Hyprland, users can additionally
            // pin via a windowrule (see BUILD.md).
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let msize = monitor.size();
                    let mpos = monitor.position();
                    let scale = monitor.scale_factor();
                    let win_w = (480.0 * scale) as i32;
                    let x = mpos.x + ((msize.width as i32 - win_w) / 2);
                    let _ = window.set_position(tauri::Position::Physical(
                        tauri::PhysicalPosition { x, y: mpos.y + 8 },
                    ));
                }
                // Dae Captain v2 Fase 8: restore the saved pill corner
                // (top-center is the default above; anything else moves now).
                if let Ok(prefs) = get_prefs(app.app_handle().clone()) {
                    if prefs.island_corner != "top-center" {
                        let _ = position_island(app.app_handle().clone(), prefs.island_corner, false);
                    }
                }
                let info = {
                    let wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
                    format!(
                        "dae-captain island: wayland={wayland}, layer-shell-pinned=false (floating panel; see BUILD.md)"
                    )
                };
                eprintln!("{info}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // The frontend intercepts close requests to show the
            // keep-alive dialog; this is a backstop only.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let _ = window;
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run dae-captain");
}

// ---------------------------------------------------------------------------
// Unit tests (run: cargo test)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as IoWrite;
    use std::net::TcpListener;

    #[test]
    fn http_get_body_returns_health_json_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = std::io::Read::read(&mut stream, &mut buf);
            let body = r#"{"status":"ok","workspace_root":"/tmp/ws"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = IoWrite::write_all(&mut stream, resp.as_bytes());
        });
        let body = http_get_body("127.0.0.1", port, "/health").expect("expected a body");
        assert!(body.contains("\"workspace_root\":\"/tmp/ws\""), "got: {body}");
    }

    #[test]
    fn http_get_body_returns_none_when_unreachable() {
        assert!(http_get_body("127.0.0.1", 1, "/health").is_none());
    }
}

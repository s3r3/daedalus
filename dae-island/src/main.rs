// dae-island — Fase 2 (data live) + Fase 3 (chat/approve).
//
// Konsep ikut zickrian/isle (docs/product-spec.md) — KODE ditulis dari nol,
// bukan salinan: isle GPL-3.0, crate ini MIT. Yang diambil hanya idenya:
// notch yang diam di atas layar, tiga presentasi (compact / peek /
// expanded), spring yang sama untuk membesar-mengecil, hover 120 ms untuk
// membuka, tutup 300 ms setelah pointer pergi (kecuali saat mengetik),
// dan alert yang muncul di tempat yang sama, bukan di tengah layar.
//
// Berbeda dari isle: tidak ada GNOME Shell extension (Hyprland mendukung
// layer-shell secara native, jadi satu window GTK4 layer-shell cukup) dan
// tidak ada daemon D-Bus — sumber datanya server Daedalus :3080 lewat HTTP.
// v1 memakai polling 2 detik (pola Quickshell yang terbukti); streaming
// WebSocket /tasks/events adalah follow-up, bukan v1.
//
// Build: cargo build (butuh libgtk-4-dev + libgtk4-layer-shell-dev).
// Jalankan: cargo run — hanya di Wayland/Hyprland (VM tidak punya display).
//
// Endpoint server yang dipakai (semua dibaca dari server/src/app.ts):
// - GET /health → { workspace_root, ... } (publik, tanpa token)
// - GET /workflow/runs?workspace_root=... → { runs: [{ turns: [...] }] }
//   (bentuk yang sama dipakai Dae Captain; turns membawa task_id, status,
//   engine, goal, pending_approvals, pending_questions, paused)
// - POST /workflow/chat/stream { message, workspace_root } → SSE
//   ("data: {delta}" / {done, run_id, text} / {error, partial})
// - POST /tasks/:id/approve { decision: "grant"|"deny" } + Bearer token
//   (token dari ~/.daedalus/daemon.json; server hanya menuntutnya kalau
//   ia sendiri punya token — kalau tidak ada, request tanpa token lolos)

use gtk4::glib;
use gtk4::prelude::*;
use gtk4::{
    Application, ApplicationWindow, Box as GtkBox, Button, CssProvider, Entry, Label,
    Orientation, ScrolledWindow, TextView,
};
use gtk4_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use std::cell::RefCell;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::rc::Rc;
use std::time::{Duration, Instant};

const APP_ID: &str = "cc.ayid.dae-island";
// Spring isle §2: stiffness 155, damping 18 (≈3.5% overshoot, settled 0.57 s).
const SPRING_STIFFNESS: f64 = 155.0;
const SPRING_DAMPING: f64 = 18.0;
const HOVER_OPEN_MS: u64 = 120;
const LEAVE_CLOSE_MS: u64 = 300;
const POLL_MS: u64 = 2000;

const COLLAPSED_W: i32 = 280;
const COLLAPSED_H: i32 = 52;
const EXPANDED_W: i32 = 480;
const EXPANDED_H: i32 = 380;

fn server_addr() -> String {
    std::env::var("DAEDALUS_ISLAND_SERVER").unwrap_or_else(|_| "127.0.0.1:3080".to_string())
}

// ---------------------------------------------------------------------------
// JSON kecil (tanpa serde_json): cukup untuk body server yang kita pakai.
// Parser rekursif standar: object, array, string (escape + \u), number,
// true/false/null. Salah sintaks → None, tidak pernah panic.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(a) => Some(a),
            _ => None,
        }
    }
    fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn value(&mut self) -> Option<Json> {
        self.ws();
        match self.peek()? {
            b'{' => {
                self.i += 1;
                let mut pairs = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Some(Json::Obj(pairs));
                }
                loop {
                    self.ws();
                    let k = match self.string()? {
                        Json::Str(s) => s,
                        _ => return None,
                    };
                    self.ws();
                    if self.peek() != Some(b':') {
                        return None;
                    }
                    self.i += 1;
                    let v = self.value()?;
                    pairs.push((k, v));
                    self.ws();
                    match self.peek()? {
                        b',' => {
                            self.i += 1;
                        }
                        b'}' => {
                            self.i += 1;
                            return Some(Json::Obj(pairs));
                        }
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Some(Json::Arr(items));
                }
                loop {
                    let v = self.value()?;
                    items.push(v);
                    self.ws();
                    match self.peek()? {
                        b',' => {
                            self.i += 1;
                        }
                        b']' => {
                            self.i += 1;
                            return Some(Json::Arr(items));
                        }
                        _ => return None,
                    }
                }
            }
            b'"' => self.string(),
            b't' => self.lit("true", Json::Bool(true)),
            b'f' => self.lit("false", Json::Bool(false)),
            b'n' => self.lit("null", Json::Null),
            b'-' | b'0'..=b'9' => {
                let start = self.i;
                while self.i < self.b.len()
                    && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                {
                    self.i += 1;
                }
                std::str::from_utf8(&self.b[start..self.i])
                    .ok()?
                    .parse::<f64>()
                    .ok()
                    .map(Json::Num)
            }
            _ => None,
        }
    }
    fn lit(&mut self, word: &str, v: Json) -> Option<Json> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Some(v)
        } else {
            None
        }
    }
    fn string(&mut self) -> Option<Json> {
        if self.peek() != Some(b'"') {
            return None;
        }
        self.i += 1;
        let mut out = String::new();
        loop {
            let c = *self.b.get(self.i)?;
            self.i += 1;
            match c {
                b'"' => return Some(Json::Str(out)),
                b'\\' => {
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hex = std::str::from_utf8(self.b.get(self.i..self.i + 4)?).ok()?;
                            let cp = u32::from_str_radix(hex, 16).ok()?;
                            self.i += 4;
                            // Surrogate pair (untuk emoji dkk).
                            if (0xD800..0xDC00).contains(&cp)
                                && self.b.get(self.i..self.i + 2) == Some(b"\\u".as_slice())
                            {
                                let hex2 =
                                    std::str::from_utf8(self.b.get(self.i + 2..self.i + 6)?).ok()?;
                                if let Ok(lo) = u32::from_str_radix(hex2, 16) {
                                    if (0xDC00..0xE000).contains(&lo) {
                                        self.i += 6;
                                        let c = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                        out.push(char::from_u32(c).unwrap_or('\u{FFFD}'));
                                        continue;
                                    }
                                }
                            }
                            out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                        }
                        _ => return None,
                    }
                }
                _ => {
                    // Byte UTF-8 mentah: kumpulkan sampai batas karakter.
                    let mut end = self.i;
                    while end < self.b.len() && (self.b[end] & 0xC0) == 0x80 {
                        end += 1;
                    }
                    let chunk = std::str::from_utf8(&self.b[self.i - 1..end]).ok()?;
                    out.push_str(chunk);
                    self.i = end;
                }
            }
        }
    }
}

fn parse_json(text: &str) -> Option<Json> {
    let mut p = Parser {
        b: text.as_bytes(),
        i: 0,
    };
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return None;
    }
    Some(v)
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// HTTP std-only (tanpa ureq/reqwest): cukup untuk server lokal.
// ---------------------------------------------------------------------------

fn http_request(method: &str, path: &str, body: Option<&str>, token: Option<&str>) -> Result<(u16, String), String> {
    let addr = server_addr();
    let mut stream = TcpStream::connect(&addr).map_err(|e| format!("connect {addr}: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
    if let Some(t) = token {
        req.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if let Some(b) = body {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    if let Some(b) = body {
        stream.write_all(b.as_bytes()).map_err(|e| e.to_string())?;
    }
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = match text.split_once("\r\n\r\n") {
        Some((h, b)) => (h, b.to_string()),
        None => (text.as_str(), String::new()),
    };
    let code = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(0);
    // Body chunked (transfer-encoding): gabungkan chunk-nya; kalau gagal,
    // pakai body mentah — parser JSON mentolerir ekor chunk kecil? Tidak:
    // chunked yang gagal parse = None di pemanggil, status tetap jujur.
    let body = if head.to_lowercase().contains("transfer-encoding: chunked") {
        dechunk(&body)
    } else {
        body
    };
    Ok((code, body))
}

fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let line_end = match rest.find("\r\n") {
            Some(i) => i,
            None => break,
        };
        let size = match usize::from_str_radix(rest[..line_end].trim(), 16) {
            Ok(n) => n,
            Err(_) => break,
        };
        if size == 0 {
            break;
        }
        let start = line_end + 2;
        if rest.len() < start + size {
            break;
        }
        out.push_str(&rest[start..start + size]);
        rest = &rest[start + size..];
        if rest.starts_with("\r\n") {
            rest = &rest[2..];
        }
    }
    out
}

fn http_get(path: &str) -> Result<(u16, String), String> {
    http_request("GET", path, None, None)
}

fn daemon_token() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let raw = std::fs::read_to_string(format!("{home}/.daedalus/daemon.json")).ok()?;
    parse_json(&raw)?.get("token")?.as_str().map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Derivasi status dari GET /workflow/runs (bentuk yang sama dipakai Dae Captain).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct TaskRow {
    task_id: String,
    goal: String,
    engine: String,
    status: String,
}

#[derive(Debug, Clone, Default)]
struct IslandState {
    connected: bool,
    running: usize,
    paused: usize,
    failed: usize,
    approval: Option<TaskRow>,
    questions: usize,
    rows: Vec<TaskRow>,
    workspace: String,
}

fn derive_state(runs_json: &Json, workspace: &str) -> IslandState {
    let mut st = IslandState {
        connected: true,
        workspace: workspace.to_string(),
        ..Default::default()
    };
    let runs = match runs_json.get("runs").and_then(|r| r.as_arr()) {
        Some(r) => r,
        None => return st,
    };
    for run in runs {
        let turns = match run.get("turns").and_then(|t| t.as_arr()) {
            Some(t) => t,
            None => continue,
        };
        for turn in turns {
            let task_id = turn.get("task_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let status = turn.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let engine = turn.get("engine").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let goal = turn
                .get("goal")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if status == "running" {
                st.running += 1;
            }
            if turn.get("paused").and_then(|v| v.as_bool()) == Some(true) {
                st.paused += 1;
            }
            if status == "failed" {
                st.failed += 1;
            }
            let approvals = turn
                .get("pending_approvals")
                .and_then(|v| v.as_arr())
                .map(|a| a.len())
                .unwrap_or(0);
            let questions = turn
                .get("pending_questions")
                .and_then(|v| v.as_arr())
                .map(|a| a.len())
                .unwrap_or(0);
            st.questions += questions;
            if approvals > 0 && st.approval.is_none() && !task_id.is_empty() {
                st.approval = Some(TaskRow {
                    task_id: task_id.clone(),
                    goal: goal.clone(),
                    engine: engine.clone(),
                    status: status.clone(),
                });
            }
            if st.rows.len() < 12 {
                st.rows.push(TaskRow {
                    task_id,
                    goal,
                    engine,
                    status,
                });
            }
        }
    }
    st
}

fn status_text(st: &IslandState) -> (&'static str, String) {
    if !st.connected {
        return ("red", "server tidak terhubung".to_string());
    }
    if let Some(a) = &st.approval {
        let goal = if a.goal.is_empty() { "task".to_string() } else { truncate(&a.goal, 28) };
        return ("amber", format!("butuh izin: {goal}"));
    }
    if st.running > 0 {
        return ("blue", format!("{} berjalan", st.running));
    }
    if st.failed > 0 {
        return ("red", format!("{} gagal", st.failed));
    }
    if st.paused > 0 {
        return ("gray", format!("{} dijeda", st.paused));
    }
    if st.questions > 0 {
        return ("amber", format!("{} butuh jawaban", st.questions));
    }
    ("green", "siap".to_string())
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

fn status_word(status: &str) -> &str {
    match status {
        "running" => "jalan",
        "failed" => "gagal",
        "done" => "selesai",
        _ => status,
    }
}

// ---------------------------------------------------------------------------
// UI: pesan antar-thread, state, spring, handler.
// Semua widget hanya disentuh dari main thread; thread poll/chat/approve
// hanya mengirim Msg lewat glib channel.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Msg {
    Poll(IslandState),
    ChatDelta(String),
    ChatDone,
    ChatError(String),
    Note(String),
}

// Pengirim antar-thread (std mpsc; glib 0.21 menghapus MainContext::channel).
type Tx = std::sync::mpsc::Sender<Msg>;

#[derive(Clone)]
struct Ui {
    dot: Label,
    status: Label,
    peek_box: GtkBox,
    peek_label: Label,
    tasks_inner: GtkBox,
    transcript: TextView,
    transcript_scroll: ScrolledWindow,
    send_btn: Button,
    entry: Entry,
    chat_box: GtkBox,
    tasks_box: GtkBox,
    chat_tab: Button,
    tasks_tab: Button,
}

#[derive(Default)]
struct UiState {
    target_expanded: bool,
    pos: f64,
    vel: f64,
    last_tick: Option<Instant>,
    tick_active: bool,
    hover_timer: Option<glib::SourceId>,
    leave_timer: Option<glib::SourceId>,
    entry_focused: bool,
    chat_busy: bool,
    assistant_started: bool,
    approval: Option<TaskRow>,
    workspace: String,
}

type SharedState = Rc<RefCell<UiState>>;

fn cancel_timer(slot: &mut Option<glib::SourceId>) {
    if let Some(id) = slot.take() {
        id.remove();
    }
}

fn start_anim(state: &SharedState, root: &GtkBox, panel: &GtkBox, target: bool) {
    {
        let mut s = state.borrow_mut();
        s.target_expanded = target;
        if target {
            // Tumbuh dari pill: panel harus terlihat dulu.
            // (panel disembunyikan lagi saat animasi mengecil selesai.)
        }
        if s.tick_active {
            return;
        }
        s.tick_active = true;
        s.last_tick = Some(Instant::now());
    }
    panel.set_visible(true);
    let state2 = state.clone();
    let root2 = root.clone();
    let panel2 = panel.clone();
    root.add_tick_callback(move |_, _| {
        let mut s = state2.borrow_mut();
        let now = Instant::now();
        let dt = s
            .last_tick
            .map(|t| now.duration_since(t).as_secs_f64())
            .unwrap_or(0.016)
            .clamp(0.0, 0.05);
        s.last_tick = Some(now);
        let target_pos = if s.target_expanded { 1.0 } else { 0.0 };
        // Spring semi-implicit Euler (stabil untuk dt kecil).
        let accel = SPRING_STIFFNESS * (target_pos - s.pos) - SPRING_DAMPING * s.vel;
        s.vel += accel * dt;
        s.pos += s.vel * dt;
        let settled = (target_pos - s.pos).abs() < 0.001 && s.vel.abs() < 0.01;
        if settled {
            s.pos = target_pos;
            s.vel = 0.0;
            s.tick_active = false;
        }
        let pos = s.pos;
        let w = (COLLAPSED_W as f64 + pos * (EXPANDED_W - COLLAPSED_W) as f64) as i32;
        let h = (COLLAPSED_H as f64 + pos * (EXPANDED_H - COLLAPSED_H) as f64) as i32;
        root2.set_size_request(w, h);
        if settled {
            if !s.target_expanded {
                panel2.set_visible(false);
            }
            glib::ControlFlow::Break
        } else {
            glib::ControlFlow::Continue
        }
    });
}

fn append_transcript(ui: &Ui, text: &str) {
    let buf = ui.transcript.buffer();
    let mut iter = buf.end_iter();
    buf.insert(&mut iter, text);
    let adj = ui.transcript_scroll.vadjustment();
    let bottom = (adj.upper() - adj.page_size()).max(0.0);
    adj.set_value(bottom);
}

fn set_dot(ui: &Ui, color: &str) {
    for cls in ["dot-green", "dot-amber", "dot-blue", "dot-red", "dot-gray"] {
        ui.dot.remove_css_class(cls);
    }
    ui.dot.add_css_class(&format!("dot-{color}"));
}

fn rebuild_tasks(ui: &Ui, rows: &[TaskRow]) {
    while let Some(child) = ui.tasks_inner.first_child() {
        ui.tasks_inner.remove(&child);
    }
    if rows.is_empty() {
        ui.tasks_inner.append(&Label::new(Some("Belum ada task.")));
        return;
    }
    for row in rows {
        let goal = if row.goal.is_empty() {
            "(tanpa judul)".to_string()
        } else {
            truncate(&row.goal, 44)
        };
        let paused = if row.status == "paused" { " — dijeda" } else { "" };
        let lbl = Label::new(Some(&format!("• [{}] {} — {}{}", row.engine, goal, status_word(&row.status), paused)));
        lbl.set_ellipsize(gtk4::pango::EllipsizeMode::End);
        lbl.set_xalign(0.0);
        ui.tasks_inner.append(&lbl);
    }
}

fn poll_once() -> IslandState {
    let health = match http_get("/health") {
        Ok((200, body)) => parse_json(&body),
        _ => None,
    };
    let workspace = health
        .as_ref()
        .and_then(|j| j.get("workspace_root").or_else(|| j.get("workspaceRoot")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if health.is_none() {
        return IslandState {
            connected: false,
            ..Default::default()
        };
    }
    let path = format!("/workflow/runs?workspace_root={}", url_encode(&workspace));
    match http_get(&path) {
        Ok((200, body)) => match parse_json(&body) {
            Some(j) => derive_state(&j, &workspace),
            None => IslandState {
                connected: true,
                workspace,
                ..Default::default()
            },
        },
        _ => IslandState {
            connected: false,
            workspace,
            ..Default::default()
        },
    }
}

fn send_chat(ui: &Ui, state: &SharedState, tx: &Tx) {
    let text = ui.entry.text().trim().to_string();
    if text.is_empty() {
        return;
    }
    {
        let mut s = state.borrow_mut();
        if s.chat_busy {
            return;
        }
        s.chat_busy = true;
        s.assistant_started = false;
    }
    ui.send_btn.set_sensitive(false);
    ui.entry.set_text("");
    append_transcript(ui, &format!("Anda: {text}\n"));
    let workspace = state.borrow().workspace.clone();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        chat_stream(&tx2, &text, &workspace);
    });
}

fn chat_stream(tx: &Tx, message: &str, workspace: &str) {
    let addr = server_addr();
    let stream = match TcpStream::connect(&addr) {
        Ok(s) => s,
        Err(e) => {
            let _ = tx.send(Msg::ChatError(format!("tidak bisa terhubung ke {addr}: {e}")));
            return;
        }
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let body = if workspace.is_empty() {
        format!("{{\"message\":\"{}\"}}", json_escape(message))
    } else {
        format!(
            "{{\"message\":\"{}\",\"workspace_root\":\"{}\"}}",
            json_escape(message),
            json_escape(workspace)
        )
    };
    let token = daemon_token();
    let mut req = format!(
        "POST /workflow/chat/stream HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(t) = token {
        req.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    req.push_str("\r\n");
    let mut writer = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            let _ = tx.send(Msg::ChatError(format!("gagal menyiapkan stream: {e}")));
            return;
        }
    };
    if writer.write_all(req.as_bytes()).is_err() || writer.write_all(body.as_bytes()).is_err() {
        let _ = tx.send(Msg::ChatError("gagal mengirim pesan ke server".to_string()));
        return;
    }
    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line).is_err() {
        let _ = tx.send(Msg::ChatError("server menutup koneksi".to_string()));
        return;
    }
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(0);
    // Lewati header.
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.trim().is_empty() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if code != 200 {
        let mut rest = String::new();
        let _ = reader.read_to_string(&mut rest);
        let _ = tx.send(Msg::ChatError(format!("HTTP {code}: {}", truncate(&rest, 120))));
        return;
    }
    let mut saw_delta = false;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let line = line.trim_end().to_string();
        let data = match line.strip_prefix("data:") {
            Some(d) => d.trim(),
            None => continue,
        };
        let json = match parse_json(data) {
            Some(j) => j,
            None => continue,
        };
        if let Some(d) = json.get("delta").and_then(|v| v.as_str()) {
            saw_delta = true;
            if tx.send(Msg::ChatDelta(d.to_string())).is_err() {
                return;
            }
        }
        if json.get("done").and_then(|v| v.as_bool()) == Some(true) {
            if !saw_delta {
                if let Some(t) = json.get("text").and_then(|v| v.as_str()) {
                    if !t.is_empty() {
                        let _ = tx.send(Msg::ChatDelta(t.to_string()));
                    }
                }
            }
            let _ = tx.send(Msg::ChatDone);
            return;
        }
        if let Some(e) = json.get("error").and_then(|v| v.as_str()) {
            let partial = json
                .get("partial")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let _ = tx.send(Msg::ChatError(if partial.is_empty() {
                e.to_string()
            } else {
                format!("{e} (sebagian: {partial})")
            }));
            return;
        }
    }
    let _ = tx.send(Msg::ChatDone);
}

fn approve_action(ui: &Ui, state: &SharedState, tx: &Tx, decision: &str) {
    let (task_id, goal) = match state.borrow().approval.clone() {
        Some(t) => (t.task_id, t.goal),
        None => return,
    };
    // Optimistis: peek hilang sekarang; kalau POST gagal, poll berikutnya
    // menampilkannya lagi karena approval masih pending di server.
    ui.peek_box.set_visible(false);
    state.borrow_mut().approval = None;
    let tx2 = tx.clone();
    let decision = decision.to_string();
    std::thread::spawn(move || {
        let token = daemon_token();
        let body = format!("{{\"decision\":\"{}\"}}", decision);
        let path = format!("/tasks/{}/approve", url_encode(&task_id));
        let verb = if decision == "grant" { "Diizinkan" } else { "Ditolak" };
        match http_request("POST", &path, Some(&body), token.as_deref()) {
            Ok((200, _)) => {
                let _ = tx2.send(Msg::Note(format!(
                    "{verb}: {}",
                    if goal.is_empty() { "task".to_string() } else { truncate(&goal, 40) }
                )));
            }
            Ok((code, _)) => {
                let _ = tx2.send(Msg::Note(format!(
                    "Gagal {verb_lower}: HTTP {code}",
                    verb_lower = verb.to_lowercase()
                )));
            }
            Err(e) => {
                let _ = tx2.send(Msg::Note(format!("Gagal {verb_lower}: {e}", verb_lower = verb.to_lowercase())));
            }
        }
    });
}

// ---------------------------------------------------------------------------
// build_ui + main
// ---------------------------------------------------------------------------

const CSS: &str = "
.pill { background: #1e293b; border-radius: 26px; color: #f8fafc; padding: 4px 12px; }
.dot { font-size: 14px; }
.dot-green { color: #22c55e; }
.dot-amber { color: #f59e0b; }
.dot-blue { color: #38bdf8; }
.dot-red { color: #ef4444; }
.dot-gray { color: #94a3b8; }
.status { color: #cbd5e1; }
.panel { background: #0f172a; border-radius: 16px; color: #e2e8f0; padding: 12px; }
.peek { background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; border-radius: 12px; padding: 8px; }
.tab-active { background: #334155; color: #f8fafc; }
";

fn build_ui(app: &Application) {
    let provider = CssProvider::new();
    provider.load_from_data(CSS);
    if let Some(display) = gtk4::gdk::Display::default() {
        gtk4::style_context_add_provider_for_display(
            &display,
            &provider,
            gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }

    let window = ApplicationWindow::builder()
        .application(app)
        .title("Dae Island")
        .decorated(false)
        .build();
    window.init_layer_shell();
    window.set_layer(Layer::Top);
    window.set_anchor(Edge::Top, true);
    window.set_margin(Edge::Top, 8);
    window.set_exclusive_zone(0);
    window.set_keyboard_mode(KeyboardMode::OnDemand);
    window.set_namespace(Some("dae-captain-island"));

    let root = GtkBox::new(Orientation::Vertical, 0);
    root.set_size_request(COLLAPSED_W, COLLAPSED_H);

    // Pill: dot + judul + status.
    let dot = Label::new(Some("●"));
    dot.add_css_class("dot");
    dot.add_css_class("dot-gray");
    let title = Label::new(Some("Dae Captain"));
    let status = Label::new(Some("menghubungkan…"));
    status.add_css_class("status");
    let pill_row = GtkBox::new(Orientation::Horizontal, 8);
    pill_row.append(&dot);
    pill_row.append(&title);
    pill_row.append(&status);
    let pill_btn = Button::new();
    pill_btn.add_css_class("pill");
    pill_btn.set_child(Some(&pill_row));

    // Panel: peek (approval) + tab Chat/Antrean.
    let panel = GtkBox::new(Orientation::Vertical, 8);
    panel.add_css_class("panel");
    panel.set_visible(false);

    let peek_label = Label::new(Some(""));
    peek_label.set_wrap(true);
    peek_label.set_xalign(0.0);
    peek_label.set_hexpand(true);
    let allow_btn = Button::with_label("Izinkan");
    let deny_btn = Button::with_label("Tolak");
    let peek_box = GtkBox::new(Orientation::Horizontal, 8);
    peek_box.add_css_class("peek");
    peek_box.append(&peek_label);
    peek_box.append(&allow_btn);
    peek_box.append(&deny_btn);
    peek_box.set_visible(false);

    let chat_tab = Button::with_label("Chat");
    chat_tab.add_css_class("tab-active");
    let tasks_tab = Button::with_label("Antrean");
    let tabs_row = GtkBox::new(Orientation::Horizontal, 4);
    tabs_row.append(&chat_tab);
    tabs_row.append(&tasks_tab);

    // Tab Chat: transkrip + entry + kirim.
    let transcript = TextView::new();
    transcript.set_editable(false);
    transcript.set_wrap_mode(gtk4::WrapMode::Word);
    transcript
        .buffer()
        .set_text("Dae Island — data live dari server :3080, polling tiap 2 detik.\n");
    let transcript_scroll = ScrolledWindow::builder().vexpand(true).hexpand(true).build();
    transcript_scroll.set_child(Some(&transcript));
    let entry = Entry::new();
    entry.set_placeholder_text(Some("Tanya Dae… (Fase 3)"));
    entry.set_hexpand(true);
    let send_btn = Button::with_label("Kirim");
    let entry_row = GtkBox::new(Orientation::Horizontal, 6);
    entry_row.append(&entry);
    entry_row.append(&send_btn);
    let chat_box = GtkBox::new(Orientation::Vertical, 8);
    chat_box.append(&transcript_scroll);
    chat_box.append(&entry_row);

    // Tab Antrean: daftar task (baca saja di v1).
    let tasks_inner = GtkBox::new(Orientation::Vertical, 4);
    let tasks_scroll = ScrolledWindow::builder().vexpand(true).hexpand(true).build();
    tasks_scroll.set_child(Some(&tasks_inner));
    let tasks_box = GtkBox::new(Orientation::Vertical, 8);
    tasks_box.append(&Label::new(Some("Task di workspace aktif:")));
    tasks_box.append(&tasks_scroll);
    tasks_box.set_visible(false);

    panel.append(&peek_box);
    panel.append(&tabs_row);
    panel.append(&chat_box);
    panel.append(&tasks_box);

    root.append(&pill_btn);
    root.append(&panel);
    window.set_child(Some(&root));

    let ui = Ui {
        dot,
        status,
        peek_box,
        peek_label,
        tasks_inner,
        transcript,
        transcript_scroll,
        send_btn,
        entry,
        chat_box,
        tasks_box,
        chat_tab,
        tasks_tab,
    };
    let state: SharedState = Rc::new(RefCell::new(UiState::default()));

    // Channel std mpsc + drain timer 100 ms: glib 0.21 menghapus
    // MainContext::channel; crate ini tetap std-only (tanpa async-channel).
    // Latensi tambahan ≤100 ms — tak terasa untuk polling 2 detik maupun
    // delta SSE (tiba per batch 100 ms).
    let (tx, rx) = std::sync::mpsc::channel::<Msg>();
    let rx = Rc::new(std::sync::Mutex::new(rx));
    {
        let ui = ui.clone();
        let state = state.clone();
        let rx = rx.clone();
        let _drain = glib::timeout_add_local(Duration::from_millis(100), move || {
            loop {
                let msg = match rx.lock().unwrap().try_recv() {
                    Ok(m) => m,
                    Err(_) => break,
                };
                match msg {
                Msg::Poll(st) => {
                    let (color, text) = status_text(&st);
                    set_dot(&ui, color);
                    ui.status.set_text(&text);
                    state.borrow_mut().workspace = st.workspace.clone();
                    state.borrow_mut().approval = st.approval.clone();
                    if let Some(a) = &st.approval {
                        let goal = if a.goal.is_empty() { "task".to_string() } else { truncate(&a.goal, 40) };
                        ui.peek_label.set_text(&format!("Butuh izin: {goal}"));
                        ui.peek_box.set_visible(true);
                    } else if state.borrow().approval.is_none() {
                        ui.peek_box.set_visible(false);
                    }
                    rebuild_tasks(&ui, &st.rows);
                }
                Msg::ChatDelta(d) => {
                    let mut s = state.borrow_mut();
                    if !s.assistant_started {
                        s.assistant_started = true;
                        drop(s);
                        append_transcript(&ui, "Dae: ");
                    }
                    append_transcript(&ui, &d);
                }
                Msg::ChatDone => {
                    let mut s = state.borrow_mut();
                    if s.assistant_started {
                        s.assistant_started = false;
                        drop(s);
                        append_transcript(&ui, "\n");
                    } else {
                        drop(s);
                        append_transcript(&ui, "Dae: (tidak ada jawaban)\n");
                    }
                    state.borrow_mut().chat_busy = false;
                    ui.send_btn.set_sensitive(true);
                }
                Msg::ChatError(e) => {
                    state.borrow_mut().chat_busy = false;
                    state.borrow_mut().assistant_started = false;
                    ui.send_btn.set_sensitive(true);
                    append_transcript(&ui, &format!("Dae: gagal — {e}\n"));
                }
                Msg::Note(line) => {
                    append_transcript(&ui, &format!("{line}\n"));
                }
            }
            }
            glib::ControlFlow::Continue
        });
    }

    // Thread polling 2 detik.
    {
        let tx = tx.clone();
        std::thread::spawn(move || loop {
            let st = poll_once();
            if tx.send(Msg::Poll(st)).is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(POLL_MS));
        });
    }

    // Klik pill: toggle.
    {
        let state = state.clone();
        let root = root.clone();
        let panel = panel.clone();
        pill_btn.connect_clicked(move |_| {
            cancel_timer(&mut state.borrow_mut().hover_timer);
            cancel_timer(&mut state.borrow_mut().leave_timer);
            let target = !state.borrow().target_expanded;
            start_anim(&state, &root, &panel, target);
        });
    }

    // Hover pill 120 ms → buka (isle §2).
    {
        let motion = gtk4::EventControllerMotion::new();
        let state_e = state.clone();
        let root_e = root.clone();
        let panel_e = panel.clone();
        motion.connect_enter(move |_, _, _| {
            if state_e.borrow().target_expanded {
                return;
            }
            cancel_timer(&mut state_e.borrow_mut().hover_timer);
            let state2 = state_e.clone();
            let root2 = root_e.clone();
            let panel2 = panel_e.clone();
            let id = glib::timeout_add_local(Duration::from_millis(HOVER_OPEN_MS), move || {
                state2.borrow_mut().hover_timer = None;
                start_anim(&state2, &root2, &panel2, true);
                glib::ControlFlow::Break
            });
            state_e.borrow_mut().hover_timer = Some(id);
        });
        let state = state.clone();
        motion.connect_leave(move |_| {
            cancel_timer(&mut state.borrow_mut().hover_timer);
        });
        pill_btn.add_controller(motion);
    }

    // Pointer pergi dari root 300 ms → tutup, kecuali saat mengetik.
    {
        let motion = gtk4::EventControllerMotion::new();
        let state_e = state.clone();
        motion.connect_enter(move |_, _, _| {
            cancel_timer(&mut state_e.borrow_mut().leave_timer);
        });
        let state_l = state.clone();
        let root_l = root.clone();
        let panel_l = panel.clone();
        motion.connect_leave(move |_| {
            if !state_l.borrow().target_expanded || state_l.borrow().entry_focused {
                return;
            }
            cancel_timer(&mut state_l.borrow_mut().leave_timer);
            let state2 = state_l.clone();
            let root2 = root_l.clone();
            let panel2 = panel_l.clone();
            let id = glib::timeout_add_local(Duration::from_millis(LEAVE_CLOSE_MS), move || {
                state2.borrow_mut().leave_timer = None;
                if !state2.borrow().entry_focused {
                    start_anim(&state2, &root2, &panel2, false);
                }
                glib::ControlFlow::Break
            });
            state_l.borrow_mut().leave_timer = Some(id);
        });
        root.add_controller(motion);
    }

    // Fokus entry = sedang mengetik → jangan auto-tutup.
    {
        let focus = gtk4::EventControllerFocus::new();
        let state_e = state.clone();
        focus.connect_enter(move |_| {
            state_e.borrow_mut().entry_focused = true;
            cancel_timer(&mut state_e.borrow_mut().leave_timer);
        });
        let state = state.clone();
        focus.connect_leave(move |_| {
            state.borrow_mut().entry_focused = false;
        });
        ui.entry.add_controller(focus);
    }

    // Tab.
    {
        let ui = ui.clone();
        let chat_tab_btn = ui.chat_tab.clone();
        let chat_tab = ui.chat_tab.clone();
        let tasks_tab = ui.tasks_tab.clone();
        let chat_box = ui.chat_box.clone();
        let tasks_box = ui.tasks_box.clone();
        chat_tab_btn.connect_clicked(move |_| {
            chat_box.set_visible(true);
            tasks_box.set_visible(false);
            chat_tab.add_css_class("tab-active");
            tasks_tab.remove_css_class("tab-active");
        });
    }
    {
        let ui = ui.clone();
        let tasks_tab_btn = ui.tasks_tab.clone();
        let chat_tab = ui.chat_tab.clone();
        let tasks_tab = ui.tasks_tab.clone();
        let chat_box = ui.chat_box.clone();
        let tasks_box = ui.tasks_box.clone();
        tasks_tab_btn.connect_clicked(move |_| {
            chat_box.set_visible(false);
            tasks_box.set_visible(true);
            tasks_tab.add_css_class("tab-active");
            chat_tab.remove_css_class("tab-active");
        });
    }

    // Kirim chat (tombol + Enter).
    {
        let ui = ui.clone();
        let state = state.clone();
        let tx = tx.clone();
        let send_btn = ui.send_btn.clone();
        send_btn.connect_clicked(move |_| {
            send_chat(&ui, &state, &tx);
        });
    }
    {
        let ui = ui.clone();
        let state = state.clone();
        let tx = tx.clone();
        let entry = ui.entry.clone();
        entry.connect_activate(move |_| {
            send_chat(&ui, &state, &tx);
        });
    }

    // Izinkan / Tolak.
    {
        let ui = ui.clone();
        let state = state.clone();
        let tx = tx.clone();
        allow_btn.connect_clicked(move |_| {
            approve_action(&ui, &state, &tx, "grant");
        });
    }
    {
        let ui = ui.clone();
        let state = state.clone();
        let tx = tx.clone();
        deny_btn.connect_clicked(move |_| {
            approve_action(&ui, &state, &tx, "deny");
        });
    }

    window.present();
}

fn main() {
    let app = Application::builder().application_id(APP_ID).build();
    app.connect_activate(build_ui);
    app.run();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_object_and_scalars() {
        let j = parse_json(r#"{"a": 1, "b": true, "c": null, "d": [1, "x"]}"#).unwrap();
        assert_eq!(j.get("a"), Some(&Json::Num(1.0)));
        assert_eq!(j.get("b"), Some(&Json::Bool(true)));
        assert_eq!(j.get("c"), Some(&Json::Null));
        assert_eq!(j.get("d").and_then(|v| v.as_arr()).unwrap().len(), 2);
        assert!(parse_json(r#"{"a": }"#).is_none());
        assert!(parse_json(r#"{"a": 1"#).is_none());
        assert!(parse_json("").is_none());
    }

    #[test]
    fn json_string_escapes() {
        let j = parse_json(r#""a\nb\"c\\d\u0041""#).unwrap();
        assert_eq!(j.as_str(), Some("a\nb\"c\\dA"));
        // Surrogate pair: U+1F600 😀
        let j = parse_json(r#""\uD83D\uDE00""#).unwrap();
        assert_eq!(j.as_str(), Some("\u{1F600}"));
    }

    #[test]
    fn json_escape_roundtrip() {
        let orig = "kutip \" backslash \\ baris\nbaru\ttab";
        let esc = json_escape(orig);
        let j = parse_json(&format!("\"{esc}\"")).unwrap();
        assert_eq!(j.as_str(), Some(orig));
    }

    #[test]
    fn url_encode_workspace() {
        assert_eq!(url_encode("/home/x y"), "%2Fhome%2Fx%20y");
        assert_eq!(url_encode("abc-_.~"), "abc-_.~");
    }

    #[test]
    fn dechunk_basic() {
        assert_eq!(dechunk("5\r\nhello\r\n0\r\n\r\n"), "hello");
        assert_eq!(dechunk("plain body"), "");
    }

    #[test]
    fn derive_counts_and_approval() {
        let body = r#"{"runs":[{"turns":[
          {"task_id":"t1","status":"running","engine":"coding","goal":"Build X","pending_approvals":[],"pending_questions":[]},
          {"task_id":"t2","status":"running","engine":"slide","goal":"Deck Y","pending_approvals":[{"kind":"exec"}],"pending_questions":[]},
          {"task_id":"t3","status":"failed","engine":"coding","goal":"Fix Z","pending_approvals":[],"pending_questions":[{"q":"?"}]},
          {"task_id":"t4","status":"done","engine":"coding","goal":"Done","pending_approvals":[],"pending_questions":[],"paused":true}
        ]}]}"#;
        let st = derive_state(&parse_json(body).unwrap(), "/ws");
        assert!(st.connected);
        assert_eq!(st.running, 2);
        assert_eq!(st.failed, 1);
        assert_eq!(st.paused, 1);
        assert_eq!(st.questions, 1);
        let a = st.approval.as_ref().unwrap();
        assert_eq!(a.task_id, "t2");
        assert_eq!(a.goal, "Deck Y");
        assert_eq!(status_text(&st).0, "amber");
    }

    #[test]
    fn derive_disconnected_and_idle() {
        let st = IslandState {
            connected: false,
            ..Default::default()
        };
        assert_eq!(status_text(&st).0, "red");
        let st = IslandState {
            connected: true,
            ..Default::default()
        };
        assert_eq!(status_text(&st), ("green", "siap".to_string()));
    }

    #[test]
    fn truncate_ascii() {
        assert_eq!(truncate("abc", 5), "abc");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }
}

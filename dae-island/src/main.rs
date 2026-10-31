// dae-island — Fase 2 (data live) + Fase 3 (chat/approve) + port konsep
// dynamic island Dae Captain (maskot, 9 status pill, progress ring,
// smart click, mode notifikasi/DND — lihat README).
//
// Lineage (koreksi 2026-10-31): bentuk dasar pill+panel, dot status,
// baris engine, dan expand/collapse berasal dari mode dynamic-island
// Dae Captain (Tauri) — BUKAN dari isle. isle (zickrian/isle, GPL-3.0)
// hanya menyumbang refinement gerak/interaksi: spring 155/18, hover
// 120 ms, tutup 300 ms, peek approval sticky. Kode di sini ditulis dari
// nol (JS→Rust rewrite); tidak ada kode isle maupun Dae Captain yang
// disalin mentah — yang dicopy adalah DATA seni maskot (path SVG) dan
// SEMANTIK status/notifikasi, dengan renderer Cairo baru.
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

mod mascot;

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
    turn_id: String,
    task_id: String,
    goal: String,
    engine: String,
    status: String,
    paused: bool,
    queued: bool,
    last_event: String,
    last_event_text: String,
    validation_failures: usize,
    pending: usize,
    updated_at: String,
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
            let turn_id = turn.get("turn_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
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
            let paused = turn.get("paused").and_then(|v| v.as_bool()).unwrap_or(false);
            if paused {
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
            let row = TaskRow {
                turn_id,
                task_id: task_id.clone(),
                goal: goal.clone(),
                engine: engine.clone(),
                status: status.clone(),
                paused,
                queued: turn.get("queued").and_then(|v| v.as_bool()).unwrap_or(false),
                last_event: turn.get("last_event").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                last_event_text: turn
                    .get("last_event_text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                validation_failures: match turn.get("validation_failures") {
                    Some(Json::Num(n)) => *n as usize,
                    _ => 0,
                },
                pending: approvals + questions,
                updated_at: turn
                    .get("updated_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            };
            if approvals > 0 && st.approval.is_none() && !task_id.is_empty() {
                st.approval = Some(row.clone());
            }
            // Tidak dipotong 12 di sini: derivasi pill butuh SEMUA turn;
            // pemotongan tampilan dilakukan di rebuild_tasks.
            st.rows.push(row);
        }
    }
    st
}

// Port derivePillState() Dae Captain (ui/logic.js) — 9 status pill dengan
// prioritas yang sama: waiting_approval > error > paused > verifying >
// fixing > working > queued > done > idle. Semua angka (progress, jumlah
// failure) dibaca dari narasi/field server sendiri, tidak pernah dibuat-buat.
fn parse_progress_fraction(text: &str) -> Option<(usize, usize)> {
    // Cari SEMUA "N/M", pakai yang TERAKHIR (narasi lama sudah basi).
    let bytes = text.as_bytes();
    let mut last: Option<(usize, usize)> = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let cur: usize = text[i..j].parse().ok()?;
            let mut k = j;
            while k < bytes.len() && (bytes[k] == b' ' || bytes[k] == b'\t') {
                k += 1;
            }
            if k < bytes.len() && bytes[k] == b'/' {
                k += 1;
                while k < bytes.len() && (bytes[k] == b' ' || bytes[k] == b'\t') {
                    k += 1;
                }
                let mut m = k;
                while m < bytes.len() && bytes[m].is_ascii_digit() {
                    m += 1;
                }
                if m > k {
                    if let Ok(total) = text[k..m].parse::<usize>() {
                        if total > 0 {
                            last = Some((cur.min(total), total));
                        }
                    }
                    i = m;
                    continue;
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    last
}

fn turn_phase_text(row: &TaskRow) -> String {
    let narration = row.last_event_text.split_whitespace().collect::<Vec<_>>().join(" ");
    if !narration.is_empty() {
        return truncate(&narration, 44);
    }
    let ev = row.last_event.to_uppercase();
    if ev.contains("VALIDATION_STARTED") {
        return "Memverifikasi…".to_string();
    }
    if ev.contains("TOOL_CALL_STARTED") {
        return "Menjalankan alat…".to_string();
    }
    if ev.contains("FILE_CHANGED") {
        return "Mengubah file…".to_string();
    }
    if ev.contains("COMMAND") || ev.contains("TEST") {
        return "Menjalankan perintah…".to_string();
    }
    if ev.contains("THOUGHT") || ev.contains("MODEL") || ev.contains("LLM") {
        return "Berpikir…".to_string();
    }
    match row.engine.as_str() {
        "slide" => "Membuat slide…",
        "dokumen" => "Menyiapkan dokumen…",
        "spreadsheet" => "Menyiapkan spreadsheet…",
        "research" => "Menjalankan riset…",
        _ => "Bekerja…",
    }
    .to_string()
}

fn task_chip(row: &TaskRow) -> String {
    let engine = if row.engine.is_empty() { "?".to_string() } else { row.engine.to_lowercase() };
    match parse_progress_fraction(&row.last_event_text) {
        Some((c, t)) => format!("{engine} {c}/{t}"),
        None => engine,
    }
}

// Detik epoch dari timestamp ISO-8601 server ("2026-10-31T12:00:00Z" atau
// dengan offset). Tanpa chrono: parse manual + days-from-civil. None =
// tidak bisa diparse → pemanggil menganggap turn masih fresh (sama seperti
// JS: Date.parse gagal → isFresh true).
fn parse_iso_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |a: usize, n: usize| -> Option<i64> {
        s.get(a..a + n)?.parse::<i64>().ok()
    };
    let y = num(0, 4)?;
    let mo = num(5, 2)?;
    let d = num(8, 2)?;
    let h = num(11, 2)?;
    let mi = num(14, 2)?;
    let se = num(17, 2)?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    // days-from-civil (Howard Hinnant).
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut secs = days * 86400 + h * 3600 + mi * 60 + se;
    // Offset zona ("+07:00" / "-05:00") — "Z" berarti UTC, tanpa offset.
    if b.len() >= 25 && (b[19] == b'+' || b[19] == b'-') {
        let oh = num(20, 2)?;
        let om = num(23, 2)?;
        let off = oh * 3600 + om * 60;
        secs += if b[19] == b'+' { -off } else { off };
    }
    Some(secs)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Default)]
struct PillMem {
    status: String,
    done_at: i64,
    failed_at: i64,
    acked: bool,
}

#[derive(Debug, Clone, Default)]
struct PillView {
    status: &'static str,
    label: String,
    dot: &'static str,
    progress: Option<(usize, usize)>,
    primary: Option<TaskRow>,
}

fn pill_dot_hex(dot: &str) -> &'static str {
    match dot {
        "green" => "#22c55e",
        "blue" => "#38bdf8",
        "purple" => "#a78bfa",
        "yellow" => "#f59e0b",
        "gray" => "#94a3b8",
        _ => "#ef4444",
    }
}

fn derive_pill(rows: &[TaskRow], memory: &mut std::collections::HashMap<String, PillMem>, dnd: bool, now: i64) -> PillView {
    const STALE_S: i64 = 30 * 60;
    let fresh = |r: &TaskRow| -> bool {
        match parse_iso_ts(&r.updated_at) {
            Some(t) => now - t < STALE_S,
            None => true,
        }
    };
    // Turn running yang fresh (filter phantom: server crash → "running" basi).
    let running: Vec<&TaskRow> = rows.iter().filter(|t| t.status == "running" && fresh(t)).collect();
    let approvals: Vec<&TaskRow> = running.iter().copied().filter(|t| t.pending > 0).collect();
    let paused: Vec<&TaskRow> = running.iter().copied().filter(|t| t.paused).collect();
    let verifying: Vec<&TaskRow> = running
        .iter()
        .copied()
        .filter(|t| !t.paused && t.last_event.to_uppercase().contains("VALIDATION_STARTED"))
        .collect();
    let fixing: Vec<&TaskRow> = running
        .iter()
        .copied()
        .filter(|t| !t.paused && t.last_event == "VALIDATION_FAILED")
        .collect();
    let queued: Vec<&TaskRow> = running.iter().copied().filter(|t| t.queued && !t.paused).collect();
    let excl: Vec<String> = verifying
        .iter()
        .chain(fixing.iter())
        .map(|t| if !t.turn_id.is_empty() { t.turn_id.clone() } else { t.task_id.clone() })
        .collect();
    let working: Vec<&TaskRow> = running
        .iter()
        .copied()
        .filter(|t| {
            !t.paused
                && !t.queued
                && t.pending == 0
                && !excl.contains(&if !t.turn_id.is_empty() { t.turn_id.clone() } else { t.task_id.clone() })
        })
        .collect();

    // Ledger lintas poll: done flash 4 detik + failure 10 menit sampai di-ack.
    let key_of = |t: &TaskRow| -> String {
        if !t.turn_id.is_empty() {
            t.turn_id.clone()
        } else {
            t.task_id.clone()
        }
    };
    let mut fresh_done: Option<&TaskRow> = None;
    for t in rows {
        let key = key_of(t);
        if key.is_empty() {
            continue;
        }
        let prev = memory.get(&key).cloned().unwrap_or_default();
        if prev.status == "running" && t.status == "done" {
            memory.insert(key, PillMem { status: "done".into(), done_at: now, failed_at: prev.failed_at, acked: false });
            fresh_done = Some(t);
        } else if prev.status == "running" && t.status == "failed" {
            memory.insert(key, PillMem { status: "failed".into(), done_at: prev.done_at, failed_at: now, acked: false });
        } else if prev.status.is_empty() {
            memory.insert(
                key,
                PillMem {
                    status: t.status.clone(),
                    done_at: if t.status == "done" { now } else { 0 },
                    failed_at: if t.status == "failed" { now } else { 0 },
                    acked: false,
                },
            );
        } else {
            memory.insert(
                key,
                PillMem {
                    status: t.status.clone(),
                    done_at: prev.done_at,
                    failed_at: prev.failed_at,
                    acked: prev.acked,
                },
            );
        }
    }
    let done_flash = match fresh_done {
        Some(t) => {
            let at = memory.get(&key_of(t)).map(|m| m.done_at).unwrap_or(0);
            if now - at < 4 { Some(t) } else { None }
        }
        None => None,
    };
    let recent_failed: Vec<&TaskRow> = rows
        .iter()
        .filter(|t| {
            if t.status != "failed" {
                return false;
            }
            let e = match memory.get(&key_of(t)) {
                Some(e) => e,
                None => return false,
            };
            if e.acked {
                return false;
            }
            let at = if e.failed_at > 0 { e.failed_at } else { parse_iso_ts(&t.updated_at).unwrap_or(0) };
            now - at < 10 * 60
        })
        .collect();

    let (status, primary): (&'static str, Option<&TaskRow>) = if !approvals.is_empty() && !dnd {
        ("waiting_approval", approvals.last().copied())
    } else if !recent_failed.is_empty() {
        ("error", recent_failed.last().copied())
    } else if !paused.is_empty() {
        ("paused", paused.last().copied())
    } else if !verifying.is_empty() {
        ("verifying", verifying.last().copied())
    } else if !fixing.is_empty() {
        ("fixing", fixing.last().copied())
    } else if !working.is_empty() {
        ("working", working.last().copied())
    } else if !queued.is_empty() {
        ("queued", queued.last().copied())
    } else if let Some(t) = done_flash {
        ("done", Some(t))
    } else {
        ("idle", None)
    };

    let active_len = paused.len() + verifying.len() + fixing.len() + working.len() + queued.len();
    let multi = active_len > 1;
    let label = match status {
        "waiting_approval" => {
            let n: usize = approvals.iter().map(|t| t.pending).sum();
            if n > 1 {
                format!("⚠ {n} butuh persetujuan")
            } else {
                "⚠ Perlu persetujuan".to_string()
            }
        }
        "error" => "✕ Gagal — lihat chat".to_string(),
        "paused" => {
            if multi {
                format!("⏸ Dijeda ({}) — klik untuk lanjut", paused.len())
            } else {
                "⏸ Dijeda — klik untuk lanjut".to_string()
            }
        }
        "verifying" => "Memverifikasi…".to_string(),
        "fixing" => match primary {
            Some(p) if p.validation_failures > 0 => {
                format!("Memperbaiki ({}/2)", p.validation_failures.min(99))
            }
            _ => "Memperbaiki…".to_string(),
        },
        "working" => {
            if multi {
                let mut chips: Vec<String> = Vec::new();
                for t in paused.iter().chain(verifying.iter()).chain(fixing.iter()).chain(working.iter()).chain(queued.iter()) {
                    chips.push(task_chip(t));
                }
                format!("{} task: {}", active_len, chips.join(" + "))
            } else {
                primary.map(turn_phase_text).unwrap_or_else(|| "Bekerja…".to_string())
            }
        }
        "queued" => {
            if queued.len() > 1 {
                format!("Antrian: {} task", queued.len())
            } else {
                "Antrian: 1 task".to_string()
            }
        }
        "done" => "✓ Selesai".to_string(),
        _ => "Dae Captain".to_string(),
    };
    let dot = match status {
        "idle" | "done" => "green",
        "working" => "blue",
        "verifying" => "purple",
        "fixing" | "waiting_approval" => "yellow",
        "paused" | "queued" => "gray",
        _ => "red",
    };
    let progress = match primary {
        Some(p) if status != "idle" && status != "done" => parse_progress_fraction(&p.last_event_text),
        _ => None,
    };
    PillView {
        status,
        label,
        dot,
        progress,
        primary: primary.cloned(),
    }
}

// Klik pill saat error: tandai semua failure sudah diakui (pill kembali ke
// status berikutnya sampai ada failure BARU). Cermin acknowledgePillErrors.
fn acknowledge_errors(rows: &[TaskRow], memory: &mut std::collections::HashMap<String, PillMem>) {
    for t in rows {
        if t.status != "failed" {
            continue;
        }
        let key = if !t.turn_id.is_empty() { t.turn_id.clone() } else { t.task_id.clone() };
        if key.is_empty() {
            continue;
        }
        let mut e = memory.get(&key).cloned().unwrap_or_default();
        e.status = "failed".to_string();
        e.acked = true;
        memory.insert(key, e);
    }
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

// Tombol aksi per baris Antrean, mengikuti semantik Dae Captain:
// terminal (done/failed/cancelled) → tanpa tombol; dijeda → Lanjut;
// sisanya → Jeda. Batal selalu ada untuk task non-terminal.
fn row_actions(status: &str, paused: bool) -> (Option<&'static str>, bool) {
    match status {
        "done" | "failed" | "cancelled" => (None, false),
        _ => (Some(if paused { "resume" } else { "pause" }), true),
    }
}

const ENGINES: [(&str, &str); 5] = [
    ("coding", "Coding"),
    ("slide", "Slide"),
    ("dokumen", "Dokumen"),
    ("spreadsheet", "Spreadsheet"),
    ("research", "Research"),
];

// Engine yang sedang bekerja (punya turn running) → disorot di baris engine.
fn active_engines(rows: &[TaskRow]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in rows {
        if r.status == "running" && !out.contains(&r.engine) {
            out.push(r.engine.clone());
        }
    }
    out
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
    pill_dot: gtk4::DrawingArea,
    pill_btn: Button,
    mascot_area: gtk4::DrawingArea,
    status: Label,
    peek_box: GtkBox,
    peek_label: Label,
    engine_labels: Vec<Label>,
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
    // Keadaan pill (port Dae Captain): status turunan terakhir, memori
    // lintas poll (done flash / error ack), dan baris terakhir untuk
    // re-derivasi saat klik error.
    pill_status: &'static str,
    pill_primary: Option<TaskRow>,
    pill_dot: &'static str,
    pill_progress: Option<(usize, usize)>,
    pill_memory: std::collections::HashMap<String, PillMem>,
    last_rows: Vec<TaskRow>,
    last_notified: Option<String>,
    prefs: Prefs,
    // Keadaan maskot: pose turunan terakhir, sejak kapan idle (tidur
    // setelah 120 detik idle, port mascot.js SLEEP_MS), offset pupil.
    mascot_pose: String,
    idle_since: Option<Instant>,
    pupil: (f64, f64),
}

type SharedState = Rc<RefCell<UiState>>;

fn cancel_timer(slot: &mut Option<glib::SourceId>) {
    if let Some(id) = slot.take() {
        id.remove();
    }
}

// Posisi pill (port pref island_corner Dae Captain): tengah = hanya atas,
// kiri/kanan = tambah anchor sisi (layer-shell mendukung perubahan live).
fn apply_corner(window: &ApplicationWindow, corner: &str) {
    window.set_anchor(Edge::Top, true);
    window.set_anchor(Edge::Left, corner == "left");
    window.set_anchor(Edge::Right, corner == "right");
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

// Preferensi pill (port Settings → Pill Dae Captain; dulu localStorage,
// di sini file JSON kecil di ~/.daedalus/ agar survive restart).
#[derive(Debug, Clone)]
struct Prefs {
    notify: String, // "pulse" (default) | "sound" | "off"
    dnd: bool,
    corner: String, // "center" (default) | "left" | "right"
    decor: String,  // "auto" (default) | kunci dekor maskot
    costume: String, // "none" (default) | kunci kostum maskot
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            notify: "pulse".to_string(),
            dnd: false,
            corner: "center".to_string(),
            decor: "auto".to_string(),
            costume: "none".to_string(),
        }
    }
}

fn prefs_path() -> Option<String> {
    std::env::var("HOME").ok().map(|h| format!("{h}/.daedalus/island-prefs.json"))
}

fn load_prefs() -> Prefs {
    let mut p = Prefs::default();
    let path = match prefs_path() {
        Some(p) => p,
        None => return p,
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return p,
    };
    let j = match parse_json(&raw) {
        Some(j) => j,
        None => return p,
    };
    if let Some(s) = j.get("notify").and_then(|v| v.as_str()) {
        if ["pulse", "sound", "off"].contains(&s) {
            p.notify = s.to_string();
        }
    }
    if let Some(b) = j.get("dnd").and_then(|v| v.as_bool()) {
        p.dnd = b;
    }
    if let Some(s) = j.get("corner").and_then(|v| v.as_str()) {
        if ["center", "left", "right"].contains(&s) {
            p.corner = s.to_string();
        }
    }
    if let Some(s) = j.get("decor").and_then(|v| v.as_str()) {
        if s == "auto" || mascot::DECORS.iter().any(|(k, _)| *k == s) {
            p.decor = s.to_string();
        }
    }
    if let Some(s) = j.get("costume").and_then(|v| v.as_str()) {
        if s == "none" || mascot::COSTUMES.iter().any(|(k, _)| *k == s) {
            p.costume = s.to_string();
        }
    }
    p
}

fn save_prefs(p: &Prefs) {
    let path = match prefs_path() {
        Some(p) => p,
        None => return,
    };
    let body = format!(
        "{{\"notify\":\"{}\",\"dnd\":{},\"corner\":\"{}\",\"decor\":\"{}\",\"costume\":\"{}\"}}",
        json_escape(&p.notify),
        p.dnd,
        json_escape(&p.corner),
        json_escape(&p.decor),
        json_escape(&p.costume)
    );
    let _ = std::fs::write(&path, body);
}

// Gambar dot pill: ring progres (kalau ada fraksi) + titik status.
// Menggantikan Label "●" + kelas CSS dot-*.
fn draw_pill_dot(cr: &gtk4::cairo::Context, dot: &str, progress: Option<(usize, usize)>) {
    let size = 28.0;
    let cx = size / 2.0;
    let cy = size / 2.0;
    if let Some((cur, total)) = progress {
        if total > 0 {
            // Latar ring redup penuh.
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.18);
            cr.set_line_width(3.0);
            cr.arc(cx, cy, 11.0, 0.0, 2.0 * std::f64::consts::PI);
            cr.stroke().ok();
            // Busur progres (mulai atas, searah jarum jam).
            let frac = cur as f64 / total as f64;
            let (r, g, b) = hex_rgb(pill_dot_hex(dot));
            cr.set_source_rgb(r, g, b);
            cr.arc(cx, cy, 11.0, -std::f64::consts::PI / 2.0, -std::f64::consts::PI / 2.0 + frac * 2.0 * std::f64::consts::PI);
            cr.stroke().ok();
        }
    }
    let (r, g, b) = hex_rgb(pill_dot_hex(dot));
    cr.set_source_rgb(r, g, b);
    cr.arc(cx, cy, 6.0, 0.0, 2.0 * std::f64::consts::PI);
    cr.fill().ok();
}

fn hex_rgb(hex: &str) -> (f64, f64, f64) {
    let h = hex.trim_start_matches('#');
    let v = |a: usize| -> f64 { u8::from_str_radix(h.get(a..a + 2).unwrap_or("00"), 16).unwrap_or(0) as f64 / 255.0 };
    (v(0), v(2), v(4))
}

// Bunyi dua-nada port _beep() pill.js (880 Hz lalu 660 Hz, sine, tanpa
// file audio): WAV disintesis std-only lalu diputar best-effort via
// ffplay. Tanpa ffplay, mode sound diam (bukan error).
fn beep() {
    std::thread::spawn(|| {
        let rate: u32 = 44100;
        let mut pcm: Vec<i16> = Vec::new();
        for (freq, start) in [(880.0, 0.0), (660.0, 0.12)] {
            let n0 = (start * rate as f64) as usize;
            if pcm.len() < n0 {
                pcm.resize(n0, 0);
            }
            let n = (0.18 * rate as f64) as usize;
            for i in 0..n {
                let t = i as f64 / rate as f64;
                let env = if i < (0.02 * rate as f64) as usize {
                    i as f64 / (0.02 * rate as f64)
                } else {
                    1.0 - (i as f64 / n as f64) * 0.9
                };
                let s = (env * 0.12 * 32767.0 * (2.0 * std::f64::consts::PI * freq * t).sin()) as i16;
                if pcm.len() <= n0 + i {
                    pcm.push(s);
                } else {
                    pcm[n0 + i] = pcm[n0 + i].saturating_add(s);
                }
            }
        }
        let data_len = pcm.len() * 2;
        let mut wav: Vec<u8> = Vec::with_capacity(44 + data_len);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data_len as u32).to_le_bytes());
        for s in pcm {
            wav.extend_from_slice(&s.to_le_bytes());
        }
        let path = std::env::temp_dir().join("dae-island-beep.wav");
        if std::fs::write(&path, wav).is_ok() {
            let _ = std::process::Command::new("ffplay")
                .args(["-nodisp", "-autoexit", "-loglevel", "quiet"])
                .arg(&path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    });
}

fn rebuild_tasks(ui: &Ui, rows: &[TaskRow], tx: &Tx) {
    while let Some(child) = ui.tasks_inner.first_child() {
        ui.tasks_inner.remove(&child);
    }
    if rows.is_empty() {
        ui.tasks_inner.append(&Label::new(Some("Belum ada task.")));
        return;
    }
    for row in rows.iter().take(12) {
        let goal = if row.goal.is_empty() {
            "(tanpa judul)".to_string()
        } else {
            truncate(&row.goal, 44)
        };
        let paused_txt = if row.paused { " — dijeda" } else { "" };
        let lbl = Label::new(Some(&format!("• [{}] {} — {}{}", row.engine, goal, status_word(&row.status), paused_txt)));
        lbl.set_ellipsize(gtk4::pango::EllipsizeMode::End);
        lbl.set_xalign(0.0);
        lbl.set_hexpand(true);
        let row_box = GtkBox::new(Orientation::Horizontal, 6);
        row_box.append(&lbl);
        let (primary, show_cancel) = row_actions(&row.status, row.paused);
        if let Some(action) = primary {
            let btn = Button::with_label(if action == "pause" { "Jeda" } else { "Lanjut" });
            let tx2 = tx.clone();
            let task_id = row.task_id.clone();
            let goal2 = row.goal.clone();
            let action = action.to_string();
            btn.connect_clicked(move |_| {
                task_action(&tx2, &task_id, &goal2, &action);
            });
            row_box.append(&btn);
        }
        if show_cancel {
            let btn = Button::with_label("Batal");
            let tx2 = tx.clone();
            let task_id = row.task_id.clone();
            let goal2 = row.goal.clone();
            btn.connect_clicked(move |_| {
                task_action(&tx2, &task_id, &goal2, "cancel");
            });
            row_box.append(&btn);
        }
        ui.tasks_inner.append(&row_box);
    }
}

fn task_action(tx: &Tx, task_id: &str, goal: &str, action: &str) {
    let tx2 = tx.clone();
    let task_id = task_id.to_string();
    let goal = goal.to_string();
    let action = action.to_string();
    std::thread::spawn(move || {
        let token = daemon_token();
        let path = format!("/tasks/{}/{}", url_encode(&task_id), action);
        // POST tanpa body, persis seperti Dae Captain (api.js req tanpa
        // body). Token dikirim kalau ada; cancel dikecualikan server (S6).
        let (verb, verb_lower) = match action.as_str() {
            "pause" => ("Dijeda", "menjeda"),
            "resume" => ("Dilanjutkan", "melanjutkan"),
            _ => ("Dibatalkan", "membatalkan"),
        };
        match http_request("POST", &path, None, token.as_deref()) {
            Ok((200, _)) => {
                let _ = tx2.send(Msg::Note(format!(
                    "{verb}: {}",
                    if goal.is_empty() { "task".to_string() } else { truncate(&goal, 40) }
                )));
            }
            Ok((code, _)) => {
                let _ = tx2.send(Msg::Note(format!("Gagal {verb_lower}: HTTP {code}")));
            }
            Err(e) => {
                let _ = tx2.send(Msg::Note(format!("Gagal {verb_lower}: {e}")));
            }
        }
    });
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
.engine { padding: 2px 8px; border-radius: 10px; color: #94a3b8; }
.engine-active { background: #0ea5e9; color: #ffffff; }
.tab-active { background: #334155; color: #f8fafc; }
.pill-pulse { animation: pill-pulse 1.5s ease-in-out infinite; }
@keyframes pill-pulse { 50% { opacity: 0.55; } }
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
    // State dibuat awal: draw func dot pill + posisi corner butuh state.
    let state: SharedState = Rc::new(RefCell::new(UiState::default()));
    state.borrow_mut().prefs = load_prefs();
    apply_corner(&window, &state.borrow().prefs.corner);
    window.set_margin(Edge::Top, 8);
    window.set_exclusive_zone(0);
    window.set_keyboard_mode(KeyboardMode::OnDemand);
    window.set_namespace(Some("dae-captain-island"));

    let root = GtkBox::new(Orientation::Vertical, 0);
    root.set_size_request(COLLAPSED_W, COLLAPSED_H);

    // Pill: dot (DrawingArea: ring progres + titik status) + judul + status.
    let pill_dot = gtk4::DrawingArea::new();
    pill_dot.set_size_request(28, 28);
    {
        let state = state.clone();
        pill_dot.set_draw_func(move |_, cr, _, _| {
            let s = state.borrow();
            draw_pill_dot(cr, s.pill_dot, s.pill_progress);
        });
    }
    let title = Label::new(Some("Dae Captain"));
    let status = Label::new(Some("menghubungkan…"));
    status.add_css_class("status");
    let pill_row = GtkBox::new(Orientation::Horizontal, 8);
    pill_row.append(&pill_dot);
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

    // Maskot Kapten (port mascot.js): pose ikut status pill + engine,
    // mata mengikuti kursor.
    let mascot_area = gtk4::DrawingArea::new();
    mascot_area.set_size_request(96, 96);
    {
        let state = state.clone();
        mascot_area.set_draw_func(move |_, cr, _, _| {
            let s = state.borrow();
            mascot::draw_mascot(cr, &s.mascot_pose, &s.prefs.decor, &s.prefs.costume, 96.0, s.pupil);
        });
    }
    {
        let state_m = state.clone();
        let area = mascot_area.clone();
        let motion = gtk4::EventControllerMotion::new();
        motion.connect_motion(move |_, x, y| {
            state_m.borrow_mut().pupil = (((x / 96.0) - 0.5) * 2.0, ((y / 96.0) - 0.5) * 2.0);
            area.queue_draw();
        });
        let state2 = state.clone();
        let area2 = mascot_area.clone();
        motion.connect_leave(move |_| {
            state2.borrow_mut().pupil = (0.0, 0.0);
            area2.queue_draw();
        });
        mascot_area.add_controller(motion);
    }
    let mascot_box = GtkBox::new(Orientation::Horizontal, 0);
    mascot_box.set_halign(gtk4::Align::Center);
    mascot_box.append(&mascot_area);

    let chat_tab = Button::with_label("Chat");
    chat_tab.add_css_class("tab-active");
    let tasks_tab = Button::with_label("Antrean");
    let tabs_row = GtkBox::new(Orientation::Horizontal, 4);
    tabs_row.append(&chat_tab);
    tabs_row.append(&tasks_tab);

    // Baris engine (warisan Dae Captain island): engine yang sedang
    // bekerja disorot, sisanya redup.
    let mut engine_labels = Vec::new();
    let engine_row = GtkBox::new(Orientation::Horizontal, 4);
    for (_, label) in ENGINES {
        let l = Label::new(Some(label));
        l.add_css_class("engine");
        engine_row.append(&l);
        engine_labels.push(l);
    }

    // Baris preferensi pill (port Settings → Pill Dae Captain): mode
    // notifikasi, jangan-ganggu, posisi pill.
    let notify_drop = gtk4::DropDown::from_strings(&["Pulse", "Bunyi", "Mati"]);
    notify_drop.set_selected(match state.borrow().prefs.notify.as_str() {
        "sound" => 1,
        "off" => 2,
        _ => 0,
    });
    let dnd_check = gtk4::CheckButton::with_label("Jangan ganggu");
    dnd_check.set_active(state.borrow().prefs.dnd);
    let corner_drop = gtk4::DropDown::from_strings(&["Tengah", "Kiri", "Kanan"]);
    corner_drop.set_selected(match state.borrow().prefs.corner.as_str() {
        "left" => 1,
        "right" => 2,
        _ => 0,
    });
    let prefs_row = GtkBox::new(Orientation::Horizontal, 6);
    prefs_row.append(&Label::new(Some("Notifikasi:")));
    prefs_row.append(&notify_drop);
    prefs_row.append(&dnd_check);
    prefs_row.append(&Label::new(Some("Posisi:")));
    prefs_row.append(&corner_drop);

    // Baris dekor/kostum maskot (port Panel Ganti Baju + dekor musiman).
    let mut decor_names: Vec<&str> = vec!["Otomatis"];
    for (_, label) in mascot::DECORS {
        decor_names.push(label);
    }
    let decor_drop = gtk4::DropDown::from_strings(&decor_names);
    {
        let cur = state.borrow().prefs.decor.clone();
        decor_drop.set_selected(if cur == "auto" {
            0
        } else {
            1 + mascot::DECORS.iter().position(|(k, _)| *k == cur).unwrap_or(0) as u32
        });
    }
    let mut costume_names: Vec<&str> = vec!["Tanpa kostum"];
    for (_, label) in mascot::COSTUMES {
        costume_names.push(label);
    }
    let costume_drop = gtk4::DropDown::from_strings(&costume_names);
    {
        let cur = state.borrow().prefs.costume.clone();
        costume_drop.set_selected(if cur == "none" {
            0
        } else {
            1 + mascot::COSTUMES.iter().position(|(k, _)| *k == cur).unwrap_or(0) as u32
        });
    }
    let mascot_row = GtkBox::new(Orientation::Horizontal, 6);
    mascot_row.append(&Label::new(Some("Dekor:")));
    mascot_row.append(&decor_drop);
    mascot_row.append(&Label::new(Some("Kostum:")));
    mascot_row.append(&costume_drop);

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

    // Tab Antrean: daftar task + tombol aksi per task.
    let tasks_inner = GtkBox::new(Orientation::Vertical, 4);
    let tasks_scroll = ScrolledWindow::builder().vexpand(true).hexpand(true).build();
    tasks_scroll.set_child(Some(&tasks_inner));
    let tasks_box = GtkBox::new(Orientation::Vertical, 8);
    tasks_box.append(&Label::new(Some("Task di workspace aktif:")));
    tasks_box.append(&tasks_scroll);
    tasks_box.set_visible(false);

    panel.append(&peek_box);
    panel.append(&mascot_box);
    panel.append(&engine_row);
    panel.append(&prefs_row);
    panel.append(&mascot_row);
    panel.append(&tabs_row);
    panel.append(&chat_box);
    panel.append(&tasks_box);

    root.append(&pill_btn);
    root.append(&panel);
    window.set_child(Some(&root));

    let ui = Ui {
        pill_dot,
        pill_btn: pill_btn.clone(),
        mascot_area,
        status,
        peek_box,
        peek_label,
        engine_labels,
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
        let tx = tx.clone();
        let _drain = glib::timeout_add_local(Duration::from_millis(100), move || {
            loop {
                let msg = match rx.lock().unwrap().try_recv() {
                    Ok(m) => m,
                    Err(_) => break,
                };
                match msg {
                Msg::Poll(st) => {
                    if !st.connected {
                        let mut s = state.borrow_mut();
                        s.pill_status = "offline";
                        s.pill_dot = "red";
                        s.pill_progress = None;
                        s.pill_primary = None;
                        s.mascot_pose = "idle".to_string();
                        s.idle_since = None;
                        drop(s);
                        ui.pill_dot.queue_draw();
                        ui.mascot_area.queue_draw();
                        ui.status.set_text("server tidak terhubung");
                        ui.peek_box.set_visible(false);
                        ui.pill_btn.remove_css_class("pill-pulse");
                        rebuild_tasks(&ui, &st.rows, &tx);
                    } else {
                        let now = now_unix();
                        let mut s = state.borrow_mut();
                        let dnd = s.prefs.dnd;
                        let view = derive_pill(&st.rows, &mut s.pill_memory, dnd, now);
                        // Bunyi: SATU kali per transisi masuk status alert,
                        // mode sound, bukan DND (port _beep pill.js).
                        let alert = matches!(view.status, "waiting_approval" | "done" | "error");
                        if alert
                            && s.last_notified.as_deref() != Some(view.status)
                            && s.prefs.notify == "sound"
                            && !dnd
                        {
                            beep();
                        }
                        if matches!(view.status, "idle" | "working") {
                            s.last_notified = None;
                        } else if alert {
                            s.last_notified = Some(view.status.to_string());
                        }
                        let pulse_on = s.prefs.notify == "pulse"
                            && matches!(view.status, "waiting_approval" | "done")
                            && !dnd;
                        s.pill_status = view.status;
                        s.pill_dot = view.dot;
                        s.pill_progress = view.progress;
                        s.pill_primary = view.primary.clone();
                        s.last_rows = st.rows.clone();
                        s.approval = st.approval.clone();
                        s.workspace = st.workspace.clone();
                        // Maskot: pose ikut status pill + engine task utama;
                        // tidur setelah 120 detik idle (port SLEEP_MS).
                        let engine = view.primary.as_ref().map(|p| p.engine.clone()).unwrap_or_default();
                        let mut pose = mascot::pose_for(view.status, &engine).to_string();
                        if view.status == "idle" {
                            match s.idle_since {
                                None => s.idle_since = Some(Instant::now()),
                                Some(t) if t.elapsed() >= Duration::from_secs(120) => {
                                    pose = "sleep".to_string()
                                }
                                _ => {}
                            }
                        } else {
                            s.idle_since = None;
                        }
                        s.mascot_pose = pose;
                        drop(s);
                        ui.pill_dot.queue_draw();
                        ui.mascot_area.queue_draw();
                        ui.status.set_text(&view.label);
                        if pulse_on {
                            ui.pill_btn.add_css_class("pill-pulse");
                        } else {
                            ui.pill_btn.remove_css_class("pill-pulse");
                        }
                        // Peek sticky hanya saat approval aktif DAN bukan DND:
                        // saat DND, approval tetap antre di tab Antrean.
                        if view.status == "waiting_approval" {
                            if let Some(a) = &view.primary {
                                let goal = if a.goal.is_empty() { "task".to_string() } else { truncate(&a.goal, 40) };
                                ui.peek_label.set_text(&format!("Butuh izin: {goal}"));
                                ui.peek_box.set_visible(true);
                            } else {
                                ui.peek_box.set_visible(false);
                            }
                        } else {
                            ui.peek_box.set_visible(false);
                        }
                        rebuild_tasks(&ui, &st.rows, &tx);
                        let active = active_engines(&st.rows);
                        for (i, (id, _)) in ENGINES.iter().enumerate() {
                            let lbl = &ui.engine_labels[i];
                            if active.iter().any(|e| e == id) {
                                lbl.add_css_class("engine-active");
                            } else {
                                lbl.remove_css_class("engine-active");
                            }
                        }
                    }
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

    // Klik pill: smart click port PillController — dijeda → lanjut,
    // error → akui semua failure, sisanya → toggle panel.
    {
        let state = state.clone();
        let root = root.clone();
        let panel = panel.clone();
        let ui_c = ui.clone();
        let tx_c = tx.clone();
        pill_btn.connect_clicked(move |_| {
            let (status, primary) = {
                let s = state.borrow();
                (s.pill_status, s.pill_primary.clone())
            };
            if status == "paused" {
                if let Some(p) = primary {
                    task_action(&tx_c, &p.task_id, &p.goal, "resume");
                    return;
                }
            }
            if status == "error" {
                let mut s = state.borrow_mut();
                let rows = s.last_rows.clone();
                acknowledge_errors(&rows, &mut s.pill_memory);
                let dnd = s.prefs.dnd;
                let view = derive_pill(&rows, &mut s.pill_memory, dnd, now_unix());
                s.pill_status = view.status;
                s.pill_dot = view.dot;
                s.pill_progress = view.progress;
                s.pill_primary = view.primary;
                drop(s);
                ui_c.pill_dot.queue_draw();
                ui_c.status.set_text(&view.label);
                return;
            }
            cancel_timer(&mut state.borrow_mut().hover_timer);
            cancel_timer(&mut state.borrow_mut().leave_timer);
            let target = !state.borrow().target_expanded;
            start_anim(&state, &root, &panel, target);
        });
    }

    // Preferensi pill: simpan + terapkan live.
    {
        let state = state.clone();
        notify_drop.connect_selected_notify(move |d| {
            let mut s = state.borrow_mut();
            s.prefs.notify = match d.selected() {
                1 => "sound",
                2 => "off",
                _ => "pulse",
            }
            .to_string();
            save_prefs(&s.prefs);
        });
    }
    {
        let state = state.clone();
        dnd_check.connect_toggled(move |c| {
            let mut s = state.borrow_mut();
            s.prefs.dnd = c.is_active();
            save_prefs(&s.prefs);
        });
    }
    {
        let state = state.clone();
        let window = window.clone();
        corner_drop.connect_selected_notify(move |d| {
            let mut s = state.borrow_mut();
            s.prefs.corner = match d.selected() {
                1 => "left",
                2 => "right",
                _ => "center",
            }
            .to_string();
            save_prefs(&s.prefs);
            apply_corner(&window, &s.prefs.corner);
        });
    }
    {
        let state = state.clone();
        let area = ui.mascot_area.clone();
        decor_drop.connect_selected_notify(move |d| {
            let mut s = state.borrow_mut();
            s.prefs.decor = if d.selected() == 0 {
                "auto".to_string()
            } else {
                mascot::DECORS[(d.selected() - 1) as usize].0.to_string()
            };
            save_prefs(&s.prefs);
            drop(s);
            area.queue_draw();
        });
    }
    {
        let state = state.clone();
        let area = ui.mascot_area.clone();
        costume_drop.connect_selected_notify(move |d| {
            let mut s = state.borrow_mut();
            s.prefs.costume = if d.selected() == 0 {
                "none".to_string()
            } else {
                mascot::COSTUMES[(d.selected() - 1) as usize].0.to_string()
            };
            save_prefs(&s.prefs);
            drop(s);
            area.queue_draw();
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
        let mut mem = std::collections::HashMap::new();
        let view = derive_pill(&st.rows, &mut mem, false, 1_800_000_000);
        assert_eq!(view.status, "waiting_approval");
        assert_eq!(view.dot, "yellow");
    }

    #[test]
    fn derive_pill_idle_and_offline_shape() {
        // Derivasi pill pada daftar kosong = idle; offline ditangani drain
        // (bukan derive_pill) sebagai dot merah + label server tidak terhubung.
        let mut mem = std::collections::HashMap::new();
        let view = derive_pill(&[], &mut mem, false, 1_800_000_000);
        assert_eq!(view.status, "idle");
        assert_eq!(view.label, "Dae Captain");
        assert_eq!(view.dot, "green");
        assert!(view.progress.is_none());
    }

    #[test]
    fn pill_priority_verifying_fixing_working_queued() {
        let mk = |id: &str, ev: &str, queued: bool| TaskRow {
            turn_id: id.to_string(),
            task_id: id.to_string(),
            goal: "G".to_string(),
            engine: "coding".to_string(),
            status: "running".to_string(),
            paused: false,
            queued,
            last_event: ev.to_string(),
            last_event_text: String::new(),
            validation_failures: if ev == "VALIDATION_FAILED" { 1 } else { 0 },
            pending: 0,
            updated_at: String::new(),
        };
        let mut mem = std::collections::HashMap::new();
        let now = 1_800_000_000;
        let rows = vec![mk("v", "VALIDATION_STARTED", false), mk("f", "VALIDATION_FAILED", false), mk("w", "TOOL_CALL_STARTED", false), mk("q", "", true)];
        assert_eq!(derive_pill(&rows, &mut mem, false, now).status, "verifying");
        let rows = vec![mk("f", "VALIDATION_FAILED", false), mk("w", "TOOL_CALL_STARTED", false), mk("q", "", true)];
        let view = derive_pill(&rows, &mut mem, false, now);
        assert_eq!(view.status, "fixing");
        assert_eq!(view.label, "Memperbaiki (1/2)");
        let rows = vec![mk("w", "TOOL_CALL_STARTED", false), mk("q", "", true)];
        assert_eq!(derive_pill(&rows, &mut mem, false, now).status, "working");
        let rows = vec![mk("q", "", true)];
        let view = derive_pill(&rows, &mut mem, false, now);
        assert_eq!(view.status, "queued");
        assert_eq!(view.label, "Antrian: 1 task");
    }

    #[test]
    fn pill_done_flash_and_error_ack() {
        let mut mem = std::collections::HashMap::new();
        let now = 1_800_000_000;
        let run = TaskRow {
            turn_id: "t".to_string(),
            task_id: "t".to_string(),
            goal: "G".to_string(),
            engine: "coding".to_string(),
            status: "running".to_string(),
            ..Default::default()
        };
        assert_eq!(derive_pill(std::slice::from_ref(&run), &mut mem, false, now).status, "working");
        let done = TaskRow { status: "done".to_string(), ..run.clone() };
        let view = derive_pill(std::slice::from_ref(&done), &mut mem, false, now);
        assert_eq!(view.status, "done");
        assert_eq!(view.label, "✓ Selesai");
        // Flash 4 detik berlalu → kembali idle (tidak ada turn aktif).
        assert_eq!(derive_pill(std::slice::from_ref(&done), &mut mem, false, now + 10).status, "idle");
        // Failure → error; klik (ack) → jatuh ke idle sampai failure baru.
        let failed = TaskRow { status: "failed".to_string(), ..run.clone() };
        let mut mem2 = std::collections::HashMap::new();
        assert_eq!(derive_pill(std::slice::from_ref(&failed), &mut mem2, false, now).status, "error");
        acknowledge_errors(std::slice::from_ref(&failed), &mut mem2);
        assert_eq!(derive_pill(std::slice::from_ref(&failed), &mut mem2, false, now).status, "idle");
    }

    #[test]
    fn progress_fraction_and_phase_text() {
        assert_eq!(parse_progress_fraction("Mengisi slide 8/12…"), Some((8, 12)));
        // Yang terakhir menang; narasi lama diabaikan.
        assert_eq!(parse_progress_fraction("3/9 lalu 5/10"), Some((5, 10)));
        assert_eq!(parse_progress_fraction("tanpa angka"), None);
        assert_eq!(parse_progress_fraction("7/0"), None);
        let row = TaskRow {
            last_event_text: "Mengisi slide 8/12…".to_string(),
            ..Default::default()
        };
        assert_eq!(turn_phase_text(&row), "Mengisi slide 8/12…");
        let row = TaskRow {
            last_event: "TOOL_CALL_STARTED".to_string(),
            engine: "coding".to_string(),
            ..Default::default()
        };
        assert_eq!(turn_phase_text(&row), "Menjalankan alat…");
        let row = TaskRow { engine: "slide".to_string(), ..Default::default() };
        assert_eq!(turn_phase_text(&row), "Membuat slide…");
        assert_eq!(task_chip(&TaskRow {
            engine: "Slide".to_string(),
            last_event_text: "8/12".to_string(),
            ..Default::default()
        }), "slide 8/12");
    }

    #[test]
    fn iso_timestamp_parse() {
        assert_eq!(parse_iso_ts("2026-10-31T12:00:00Z"), Some(1_793_448_000));
        // Offset +07:00 dikurangkan kembali ke UTC.
        assert_eq!(parse_iso_ts("2026-10-31T19:00:00+07:00"), Some(1_793_448_000));
        assert_eq!(parse_iso_ts("bukan tanggal"), None);
        assert_eq!(parse_iso_ts(""), None);
    }

    #[test]
    fn truncate_ascii() {
        assert_eq!(truncate("abc", 5), "abc");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }

    #[test]
    fn row_actions_by_state() {
        assert_eq!(row_actions("done", false), (None, false));
        assert_eq!(row_actions("failed", false), (None, false));
        assert_eq!(row_actions("cancelled", false), (None, false));
        assert_eq!(row_actions("running", false), (Some("pause"), true));
        assert_eq!(row_actions("running", true), (Some("resume"), true));
    }

    #[test]
    fn active_engines_from_running() {
        let rows = vec![
            TaskRow { task_id: "t1".into(), goal: "".into(), engine: "coding".into(), status: "running".into(), paused: false, ..Default::default() },
            TaskRow { task_id: "t2".into(), goal: "".into(), engine: "slide".into(), status: "done".into(), paused: false, ..Default::default() },
            TaskRow { task_id: "t3".into(), goal: "".into(), engine: "coding".into(), status: "running".into(), paused: true, ..Default::default() },
        ];
        assert_eq!(active_engines(&rows), vec!["coding".to_string()]);
    }
}

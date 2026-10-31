//! Dae Captain mascot ("Kapten") ported from the Tauri UI to dae-island.
//!
//! Source: `dae-captain/ui/mascot.js` at `2be3795d` (inline-SVG mascot v2).
//! The art tables at the bottom of this file (`BODY`, `FACES`, `ACCS`,
//! `DECOR_SLOTS`, `GRADIENTS`, `PATTERNS`) are generated verbatim from that
//! file: same path `d` strings, circle/ellipse/rect geometry, fill colors,
//! gradients, patterns and transforms. Nothing was redesigned.
//!
//! Static render only. The JS module's CSS animations (blink, float, twinkle,
//! falling petals, spinning, ...) are drawn at their base state (untransformed,
//! fully opaque). Click-bounce actions (`ACTIONS`/`MOTION`), sleep timing and
//! DND are NOT implemented here — those are the integrator's wiring (sleep is
//! an idle-duration decision by the app, not a property of the art).
//!
//! Known deviations from the JS original, stated plainly:
//! - `auto_decor` covers only the Gregorian event/season rules. The JS
//!   ramadan/eid rules need a Hijri (Umm al-Qura) calendar via `Intl`, which
//!   is not available std-only; implementing the tabular Umm al-Qura calendar
//!   is out of scope for this port, so those two decors never auto-select.
//!   They still render when requested explicitly as `decor`/`costume` keys.
//! - Dates use UTC (`SystemTime` + days-to-civil). The JS uses the local date,
//!   so the auto decor may differ near midnight local time.
//! - Text uses cairo's toy text API (`Sans`, bold when `font-weight=700`); the
//!   browser's font rendering will differ slightly.
//! - The JS `sm` size hides ambient decor (`dm-amb`); `draw_mascot` has no
//!   size variant, so ambient decor is always drawn.
//! - The queued-pose count badge uses the JS default (`2`); `draw_mascot`
//!   takes no count parameter.
//! - Action-only faces (`surprised`, `kiss`, `wink`) and the dead `captain`
//!   alias are not ported: they are only used by click actions (out of scope).
//!
//! Cairo import: `main.rs` itself imports no cairo, so there is no existing
//! import to match. `gtk4` (0.10, pinned by `Cargo.lock`) re-exports the
//! cairo crate, so this module uses `gtk4::cairo`.

use gtk4::cairo;
use std::f64::consts::PI;
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Art data types (tables are generated at the bottom of this file)
// ---------------------------------------------------------------------------

/// One drawable SVG node. `Group.transform` is the verbatim SVG transform
/// string (empty = identity); `Group.look` marks a `dm-look` eye group, which
/// `draw_mascot` shifts by the `pupil` offset for cursor-follow.
#[derive(Clone, Copy)]
pub enum Node {
    Group {
        transform: &'static str,
        look: bool,
        children: &'static [Node],
    },
    Path {
        d: &'static str,
        paint: Paint,
    },
    Circle {
        cx: f64,
        cy: f64,
        r: f64,
        paint: Paint,
    },
    Ellipse {
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
        paint: Paint,
    },
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        rx: f64,
        ry: f64,
        paint: Paint,
    },
    Text {
        x: f64,
        y: f64,
        size: f64,
        bold: bool,
        middle: bool,
        rgb: (u8, u8, u8),
        opacity: f64,
        text: &'static str,
    },
}

#[derive(Clone, Copy)]
pub struct Paint {
    pub fill: Fill,
    pub fill_opacity: f64,
    pub stroke: Option<Stroke>,
    pub opacity: f64,
}

#[derive(Clone, Copy)]
pub enum Fill {
    None,
    Rgb(u8, u8, u8),
    /// Gradient id from `GRADIENTS` (objectBoundingBox fractions).
    Grad(&'static str),
    /// Pattern id from `PATTERNS` (userSpaceOnUse tiles).
    Pattern(&'static str),
}

#[derive(Clone, Copy)]
pub struct Stroke {
    pub rgb: (u8, u8, u8),
    pub width: f64,
    pub cap: Cap,
    pub join: Join,
    pub dash: &'static [f64],
}

#[derive(Clone, Copy, PartialEq)]
pub enum Cap {
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Join {
    Miter,
    Round,
    Bevel,
}

// ---------------------------------------------------------------------------
// Public catalogue (mirrors DECOR_LABELS / COSTUME_LABELS / MOOD in mascot.js)
// ---------------------------------------------------------------------------

/// (key, Indonesian label) for the 12 decors, in JS order.
pub const DECORS: &[(&str, &str)] = &[
    ("default", "Kapten"),
    ("spring", "Musim Semi"),
    ("summer", "Musim Panas"),
    ("autumn", "Musim Gugur"),
    ("winter", "Musim Dingin"),
    ("halloween", "Halloween"),
    ("christmas", "Natal"),
    ("newyear", "Tahun Baru"),
    ("valentine", "Valentine"),
    ("ramadan", "Ramadan"),
    ("eid", "Idulfitri"),
    ("independence", "HUT RI"),
];

/// (key, Indonesian label) for the 10 manual costumes, in JS order.
pub const COSTUMES: &[(&str, &str)] = &[
    ("batik", "Batik · Indonesia"),
    ("kimono", "Kimono · Jepang"),
    ("hanbok", "Hanbok · Korea"),
    ("changshan", "Changshan · Tiongkok"),
    ("kurta", "Kurta · India"),
    ("thobe", "Thobe · Arab"),
    ("jas", "Setelan Jas · Inggris"),
    ("beret", "Beret · Prancis"),
    ("sombrero", "Sombrero · Meksiko"),
    ("aloha", "Aloha · Hawaii"),
];

/// Idle face per decor/costume key (mirrors `MOOD` in mascot.js).
const MOOD: &[(&str, &str)] = &[
    ("default", "ready"),
    ("spring", "dreamy"),
    ("summer", "grin"),
    ("autumn", "cozy"),
    ("halloween", "devious"),
    ("winter", "shiver"),
    ("christmas", "dreamy"),
    ("newyear", "sparkle"),
    ("valentine", "love"),
    ("ramadan", "cozy"),
    ("eid", "dreamy"),
    ("independence", "ready"),
    ("batik", "cozy"),
    ("kimono", "cozy"),
    ("hanbok", "dreamy"),
    ("changshan", "ready"),
    ("kurta", "dreamy"),
    ("thobe", "cozy"),
    ("jas", "ready"),
    ("beret", "dreamy"),
    ("sombrero", "sparkle"),
    ("aloha", "dreamy"),
];

// ---------------------------------------------------------------------------
// Date / decor resolution
// ---------------------------------------------------------------------------

/// Days since the Unix epoch as (year, month, day) in UTC, via the standard
/// days-to-civil algorithm (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Decor key for today (UTC), mirroring `currentDecor(date, "auto")` in
/// mascot.js minus the Hijri ramadan/eid rules (see the header note).
pub fn auto_decor() -> &'static str {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let (_, m, d) = civil_from_days(days);
    if (m == 12 && d == 31) || (m == 1 && d <= 2) {
        return "newyear";
    }
    if m == 12 && (20..=26).contains(&d) {
        return "christmas";
    }
    if m == 10 || (m == 11 && d == 1) {
        return "halloween";
    }
    if m == 2 && (13..=15).contains(&d) {
        return "valentine";
    }
    if m == 8 && (10..=20).contains(&d) {
        return "independence";
    }
    match m {
        3..=5 => "spring",
        6..=8 => "summer",
        9..=11 => "autumn",
        _ => "winter",
    }
}

// ---------------------------------------------------------------------------
// Status -> pose (mirrors resolvePose in mascot.js exactly)
// ---------------------------------------------------------------------------

fn engine_pose_key(key: &str) -> Option<&'static str> {
    match key {
        "coding" => Some("coding"),
        "slide" => Some("slide"),
        "dokumen" | "document" => Some("document"),
        "spreadsheet" => Some("spreadsheet"),
        "research" => Some("research"),
        _ => None,
    }
}

/// Map a pill status + engine to a pose, exactly as `resolvePose` does:
/// `waiting_approval` -> `permission`; a working-like status uses the engine
/// pose when known (the status itself counts as an engine key first), else
/// `working`; any other known pose name passes through; anything else -> `idle`.
pub fn pose_for(status: &str, engine: &str) -> &'static str {
    let s = status.to_ascii_lowercase();
    let e = engine.to_ascii_lowercase();
    match s.as_str() {
        "working" | "coding" | "slide" | "document" | "dokumen" | "spreadsheet" | "research" => {
            let key = if engine_pose_key(&s).is_some() {
                s.as_str()
            } else {
                e.as_str()
            };
            engine_pose_key(key).unwrap_or("working")
        }
        "waiting_approval" | "permission" => "permission",
        "idle" => "idle",
        "thinking" => "thinking",
        "verifying" => "verifying",
        "fixing" => "fixing",
        "paused" => "paused",
        "queued" => "queued",
        "done" => "done",
        "error" => "error",
        "sleep" => "sleep",
        _ => "idle",
    }
}

// ---------------------------------------------------------------------------
// Key resolution for draw_mascot
// ---------------------------------------------------------------------------

/// Effective decor/costume key: an explicitly known costume wins, then a known
/// decor/costume key, else the auto decor (mirrors `mascotSvgString`'s
/// `ALL_KEYS.includes(o.decor) ? o.decor : currentDecor()`).
fn resolve_key(decor: &str, costume: &str) -> &'static str {
    match costume {
        "batik" => "batik",
        "kimono" => "kimono",
        "hanbok" => "hanbok",
        "changshan" => "changshan",
        "kurta" => "kurta",
        "thobe" => "thobe",
        "jas" => "jas",
        "beret" => "beret",
        "sombrero" => "sombrero",
        "aloha" => "aloha",
        _ => match decor {
            "default" => "default",
            "spring" => "spring",
            "summer" => "summer",
            "autumn" => "autumn",
            "winter" => "winter",
            "halloween" => "halloween",
            "christmas" => "christmas",
            "newyear" => "newyear",
            "valentine" => "valentine",
            "ramadan" => "ramadan",
            "eid" => "eid",
            "independence" => "independence",
            "batik" => "batik",
            "kimono" => "kimono",
            "hanbok" => "hanbok",
            "changshan" => "changshan",
            "kurta" => "kurta",
            "thobe" => "thobe",
            "jas" => "jas",
            "beret" => "beret",
            "sombrero" => "sombrero",
            "aloha" => "aloha",
            _ => auto_decor(),
        },
    }
}

fn mood_for(key: &str) -> &'static str {
    MOOD.iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| *v)
        .unwrap_or("idle")
}

fn face_nodes(key: &str) -> &'static [Node] {
    FACES
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, n)| *n)
        .unwrap_or_else(|| {
            FACES
                .iter()
                .find(|(k, _)| *k == "idle")
                .map(|(_, n)| *n)
                .unwrap_or(&[])
        })
}

fn acc_nodes(pose: &str) -> &'static [Node] {
    ACCS.iter()
        .find(|(k, _)| *k == pose)
        .map(|(_, n)| *n)
        .unwrap_or_else(|| {
            ACCS.iter()
                .find(|(k, _)| *k == "idle")
                .map(|(_, n)| *n)
                .unwrap_or(&[])
        })
}

fn slots_for(key: &str) -> &'static Slots {
    DECOR_SLOTS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, s)| s)
        .unwrap_or_else(|| {
            DECOR_SLOTS
                .iter()
                .find(|(k, _)| *k == "default")
                .map(|(_, s)| s)
                .unwrap_or(&EMPTY_SLOTS)
        })
}

const EMPTY_SLOTS: Slots = Slots {
    amb: &[],
    neck: &[],
    head: &[],
    eyes: &[],
};

fn paws_for(pose: &str) -> &'static [Node] {
    match pose {
        "idle" => PAWS_LEFT,
        "thinking" => PAWS_RIGHT,
        "done" => &[],
        _ => PAWS_BASE,
    }
}

/// Shadow ellipse under the body (radial gradient `dm-sh`), from `layers()`
/// assembly in mascot.js.
const SHADOW_PAINT: Paint = Paint {
    fill: Fill::Grad("dm-sh"),
    fill_opacity: 1.0,
    stroke: None,
    opacity: 1.0,
};

// ---------------------------------------------------------------------------
// SVG path parser (supports M/L/H/V/C/S/Q/T/A/Z, absolute + relative)
// ---------------------------------------------------------------------------

enum Tok {
    Letter(u8),
    Num(f64),
}

fn tokenize_path(d: &str) -> Vec<Tok> {
    let bytes = d.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_ascii_alphabetic() {
            toks.push(Tok::Letter(bytes[i]));
            i += 1;
        } else if c == '-' || c == '+' || c == '.' || c.is_ascii_digit() {
            let start = i;
            if bytes[i] == b'-' || bytes[i] == b'+' {
                i += 1;
            }
            let mut seen_digit = false;
            let mut seen_dot = false;
            while i < bytes.len() {
                let ch = bytes[i] as char;
                if ch.is_ascii_digit() {
                    seen_digit = true;
                    i += 1;
                } else if ch == '.' && !seen_dot {
                    seen_dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
                let mut j = i + 1;
                if j < bytes.len() && (bytes[j] == b'-' || bytes[j] == b'+') {
                    j += 1;
                }
                if j < bytes.len() && (bytes[j] as char).is_ascii_digit() {
                    i = j;
                    while i < bytes.len() && (bytes[i] as char).is_ascii_digit() {
                        i += 1;
                    }
                }
            }
            if seen_digit {
                if let Ok(v) = d[start..i].parse::<f64>() {
                    toks.push(Tok::Num(v));
                }
            } else {
                // Lone sign/dot with no digits: skip one byte so we always
                // make progress.
                i = start + 1;
            }
        } else {
            // Separator (space, comma, ...).
            i += 1;
        }
    }
    toks
}

fn next_num(toks: &[Tok], i: &mut usize) -> f64 {
    if let Some(Tok::Num(v)) = toks.get(*i) {
        *i += 1;
        *v
    } else {
        0.0
    }
}

fn reflect(p: (f64, f64), cur: (f64, f64)) -> (f64, f64) {
    (2.0 * cur.0 - p.0, 2.0 * cur.1 - p.1)
}

fn quad_to(cr: &cairo::Context, cur: (f64, f64), q: (f64, f64), end: (f64, f64)) {
    let c1 = (
        cur.0 + 2.0 / 3.0 * (q.0 - cur.0),
        cur.1 + 2.0 / 3.0 * (q.1 - cur.1),
    );
    let c2 = (
        end.0 + 2.0 / 3.0 * (q.0 - end.0),
        end.1 + 2.0 / 3.0 * (q.1 - end.1),
    );
    cr.curve_to(c1.0, c1.1, c2.0, c2.1, end.0, end.1);
}

fn ellipse_point(cx: f64, cy: f64, rx: f64, ry: f64, phi: f64, t: f64) -> ((f64, f64), (f64, f64)) {
    let (cp, sp) = (phi.cos(), phi.sin());
    let (ct, st) = (t.cos(), t.sin());
    let p = (
        cx + rx * ct * cp - ry * st * sp,
        cy + rx * ct * sp + ry * st * cp,
    );
    let d = (-rx * st * cp - ry * ct * sp, -rx * st * sp + ry * ct * cp);
    (p, d)
}

/// Elliptical arc, endpoint parameterization (SVG spec appendix F.6.5),
/// approximated with cubic beziers (segments of at most 90 degrees).
#[allow(clippy::too_many_arguments)]
fn arc_to(
    cr: &cairo::Context,
    cur: (f64, f64),
    rx: f64,
    ry: f64,
    phi_deg: f64,
    large: bool,
    sweep: bool,
    end: (f64, f64),
) {
    let (x1, y1) = cur;
    let (x2, y2) = end;
    if rx == 0.0 || ry == 0.0 {
        cr.line_to(x2, y2);
        return;
    }
    if (x1 - x2).abs() < 1e-9 && (y1 - y2).abs() < 1e-9 {
        return;
    }
    let phi = phi_deg.to_radians();
    let (cos_p, sin_p) = (phi.cos(), phi.sin());
    let dx = (x1 - x2) / 2.0;
    let dy = (y1 - y2) / 2.0;
    let x1p = cos_p * dx + sin_p * dy;
    let y1p = -sin_p * dx + cos_p * dy;
    let mut rx = rx.abs();
    let mut ry = ry.abs();
    let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lam > 1.0 {
        let s = lam.sqrt();
        rx *= s;
        ry *= s;
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut co = if den == 0.0 {
        0.0
    } else {
        (num / den).max(0.0).sqrt()
    };
    if large == sweep {
        co = -co;
    }
    let cxp = co * rx * y1p / ry;
    let cyp = -co * ry * x1p / rx;
    let cx = cos_p * cxp - sin_p * cyp + (x1 + x2) / 2.0;
    let cy = sin_p * cxp + cos_p * cyp + (y1 + y2) / 2.0;
    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| -> f64 {
        let dot = ux * vx + uy * vy;
        let len = (ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt();
        let mut a = if len == 0.0 {
            0.0
        } else {
            (dot / len).clamp(-1.0, 1.0).acos()
        };
        if ux * vy - uy * vx < 0.0 {
            a = -a;
        }
        a
    };
    let theta1 = angle(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut dtheta = angle(
        (x1p - cxp) / rx,
        (y1p - cyp) / ry,
        (-x1p - cxp) / rx,
        (-y1p - cyp) / ry,
    );
    if !sweep && dtheta > 0.0 {
        dtheta -= 2.0 * PI;
    }
    if sweep && dtheta < 0.0 {
        dtheta += 2.0 * PI;
    }
    let n = (dtheta.abs() / (PI / 2.0)).ceil().max(1.0) as i32;
    let delta = dtheta / n as f64;
    for k in 0..n {
        let t1 = theta1 + delta * k as f64;
        let t2 = t1 + delta;
        let alpha = 4.0 / 3.0 * (delta / 4.0).tan();
        let (p1, d1) = ellipse_point(cx, cy, rx, ry, phi, t1);
        let (p2, d2) = ellipse_point(cx, cy, rx, ry, phi, t2);
        cr.curve_to(
            p1.0 + alpha * d1.0,
            p1.1 + alpha * d1.1,
            p2.0 - alpha * d2.0,
            p2.1 - alpha * d2.1,
            p2.0,
            p2.1,
        );
    }
}

fn draw_path(cr: &cairo::Context, d: &str) {
    let toks = tokenize_path(d);
    let mut i = 0usize;
    let mut cmd: u8 = 0;
    let mut cur = (0.0f64, 0.0f64);
    let mut start = (0.0f64, 0.0f64);
    let mut prev_cubic: Option<(f64, f64)> = None;
    let mut prev_quad: Option<(f64, f64)> = None;
    while i < toks.len() {
        match toks[i] {
            Tok::Letter(c) => {
                cmd = c;
                i += 1;
                if cmd == b'Z' || cmd == b'z' {
                    cr.close_path();
                    cur = start;
                    prev_cubic = None;
                    prev_quad = None;
                } else if cmd == b'M' || cmd == b'm' {
                    let x = next_num(&toks, &mut i);
                    let y = next_num(&toks, &mut i);
                    let p = if cmd == b'M' {
                        (x, y)
                    } else {
                        (cur.0 + x, cur.1 + y)
                    };
                    cr.move_to(p.0, p.1);
                    cur = p;
                    start = p;
                    prev_cubic = None;
                    prev_quad = None;
                    // Further coordinate pairs after M are implicit linetos.
                    cmd = if cmd == b'M' { b'L' } else { b'l' };
                }
            }
            Tok::Num(_) => match cmd {
                b'L' => {
                    let x = next_num(&toks, &mut i);
                    let y = next_num(&toks, &mut i);
                    cur = (x, y);
                    cr.line_to(x, y);
                    prev_cubic = None;
                    prev_quad = None;
                }
                b'l' => {
                    let x = next_num(&toks, &mut i);
                    let y = next_num(&toks, &mut i);
                    cur = (cur.0 + x, cur.1 + y);
                    cr.line_to(cur.0, cur.1);
                    prev_cubic = None;
                    prev_quad = None;
                }
                b'H' => {
                    let x = next_num(&toks, &mut i);
                    cur = (x, cur.1);
                    cr.line_to(x, cur.1);
                    prev_cubic = None;
                    prev_quad = None;
                }
                b'h' => {
                    let dx = next_num(&toks, &mut i);
                    cur = (cur.0 + dx, cur.1);
                    cr.line_to(cur.0, cur.1);
                    prev_cubic = None;
                    prev_quad = None;
                }
                b'V' => {
                    let y = next_num(&toks, &mut i);
                    cur = (cur.0, y);
                    cr.line_to(cur.0, y);
                    prev_cubic = None;
                    prev_quad = None;
                }
                b'v' => {
                    let dy = next_num(&toks, &mut i);
                    cur = (cur.0, cur.1 + dy);
                    cr.line_to(cur.0, cur.1);
                    prev_cubic = None;
                    prev_quad = None;
                }
                b'C' => {
                    let x1 = next_num(&toks, &mut i);
                    let y1 = next_num(&toks, &mut i);
                    let x2 = next_num(&toks, &mut i);
                    let y2 = next_num(&toks, &mut i);
                    let x = next_num(&toks, &mut i);
                    let y = next_num(&toks, &mut i);
                    cr.curve_to(x1, y1, x2, y2, x, y);
                    prev_cubic = Some((x2, y2));
                    prev_quad = None;
                    cur = (x, y);
                }
                b'c' => {
                    let dx1 = next_num(&toks, &mut i);
                    let dy1 = next_num(&toks, &mut i);
                    let dx2 = next_num(&toks, &mut i);
                    let dy2 = next_num(&toks, &mut i);
                    let dx = next_num(&toks, &mut i);
                    let dy = next_num(&toks, &mut i);
                    let x1 = cur.0 + dx1;
                    let y1 = cur.1 + dy1;
                    let x2 = cur.0 + dx2;
                    let y2 = cur.1 + dy2;
                    let end = (cur.0 + dx, cur.1 + dy);
                    cr.curve_to(x1, y1, x2, y2, end.0, end.1);
                    prev_cubic = Some((x2, y2));
                    prev_quad = None;
                    cur = end;
                }
                b'S' => {
                    let x2 = next_num(&toks, &mut i);
                    let y2 = next_num(&toks, &mut i);
                    let x = next_num(&toks, &mut i);
                    let y = next_num(&toks, &mut i);
                    let c1 = prev_cubic.map(|p| reflect(p, cur)).unwrap_or(cur);
                    cr.curve_to(c1.0, c1.1, x2, y2, x, y);
                    prev_cubic = Some((x2, y2));
                    prev_quad = None;
                    cur = (x, y);
                }
                b's' => {
                    let dx2 = next_num(&toks, &mut i);
                    let dy2 = next_num(&toks, &mut i);
                    let dx = next_num(&toks, &mut i);
                    let dy = next_num(&toks, &mut i);
                    let c1 = prev_cubic.map(|p| reflect(p, cur)).unwrap_or(cur);
                    let x2 = cur.0 + dx2;
                    let y2 = cur.1 + dy2;
                    let end = (cur.0 + dx, cur.1 + dy);
                    cr.curve_to(c1.0, c1.1, x2, y2, end.0, end.1);
                    prev_cubic = Some((x2, y2));
                    prev_quad = None;
                    cur = end;
                }
                b'Q' => {
                    let qx = next_num(&toks, &mut i);
                    let qy = next_num(&toks, &mut i);
                    let x = next_num(&toks, &mut i);
                    let y = next_num(&toks, &mut i);
                    quad_to(cr, cur, (qx, qy), (x, y));
                    prev_quad = Some((qx, qy));
                    prev_cubic = None;
                    cur = (x, y);
                }
                b'q' => {
                    let dqx = next_num(&toks, &mut i);
                    let dqy = next_num(&toks, &mut i);
                    let dx = next_num(&toks, &mut i);
                    let dy = next_num(&toks, &mut i);
                    let q = (cur.0 + dqx, cur.1 + dqy);
                    let end = (cur.0 + dx, cur.1 + dy);
                    quad_to(cr, cur, q, end);
                    prev_quad = Some(q);
                    prev_cubic = None;
                    cur = end;
                }
                b'T' => {
                    let x = next_num(&toks, &mut i);
                    let y = next_num(&toks, &mut i);
                    let q = prev_quad.map(|p| reflect(p, cur)).unwrap_or(cur);
                    quad_to(cr, cur, q, (x, y));
                    prev_quad = Some(q);
                    prev_cubic = None;
                    cur = (x, y);
                }
                b't' => {
                    let dx = next_num(&toks, &mut i);
                    let dy = next_num(&toks, &mut i);
                    let q = prev_quad.map(|p| reflect(p, cur)).unwrap_or(cur);
                    let end = (cur.0 + dx, cur.1 + dy);
                    quad_to(cr, cur, q, end);
                    prev_quad = Some(q);
                    prev_cubic = None;
                    cur = end;
                }
                b'A' => {
                    let rx = next_num(&toks, &mut i);
                    let ry = next_num(&toks, &mut i);
                    let phi = next_num(&toks, &mut i);
                    let large = next_num(&toks, &mut i) != 0.0;
                    let sweep = next_num(&toks, &mut i) != 0.0;
                    let x = next_num(&toks, &mut i);
                    let y = next_num(&toks, &mut i);
                    arc_to(cr, cur, rx, ry, phi, large, sweep, (x, y));
                    cur = (x, y);
                    prev_cubic = None;
                    prev_quad = None;
                }
                b'a' => {
                    let rx = next_num(&toks, &mut i);
                    let ry = next_num(&toks, &mut i);
                    let phi = next_num(&toks, &mut i);
                    let large = next_num(&toks, &mut i) != 0.0;
                    let sweep = next_num(&toks, &mut i) != 0.0;
                    let dx = next_num(&toks, &mut i);
                    let dy = next_num(&toks, &mut i);
                    let end = (cur.0 + dx, cur.1 + dy);
                    arc_to(cr, cur, rx, ry, phi, large, sweep, end);
                    cur = end;
                    prev_cubic = None;
                    prev_quad = None;
                }
                _ => {
                    // Unknown command (or stray numbers after Z): consume one
                    // number so the loop always makes progress.
                    i += 1;
                }
            },
        }
    }
}

// ---------------------------------------------------------------------------
// SVG transform lists (translate / rotate / scale, in order)
// ---------------------------------------------------------------------------

fn apply_transform(cr: &cairo::Context, t: &str) {
    let bytes = t.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && !(bytes[i] as char).is_ascii_alphabetic() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let start = i;
        while i < bytes.len() && (bytes[i] as char).is_ascii_alphabetic() {
            i += 1;
        }
        let name = &t[start..i];
        while i < bytes.len() && bytes[i] != b'(' {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        i += 1;
        let mut nums: Vec<f64> = Vec::new();
        let mut cur = String::new();
        while i < bytes.len() && bytes[i] != b')' {
            let ch = bytes[i] as char;
            if ch == ',' || ch == ' ' || ch == '\t' || ch == '\n' {
                if !cur.is_empty() {
                    if let Ok(v) = cur.parse::<f64>() {
                        nums.push(v);
                    }
                    cur.clear();
                }
            } else {
                cur.push(ch);
            }
            i += 1;
        }
        if !cur.is_empty() {
            if let Ok(v) = cur.parse::<f64>() {
                nums.push(v);
            }
        }
        if i < bytes.len() {
            i += 1; // consume ')'
        }
        match name {
            "translate" => {
                let tx = nums.first().copied().unwrap_or(0.0);
                let ty = nums.get(1).copied().unwrap_or(0.0);
                cr.translate(tx, ty);
            }
            "rotate" => {
                let a = nums.first().copied().unwrap_or(0.0).to_radians();
                if nums.len() >= 3 {
                    let (cx, cy) = (nums[1], nums[2]);
                    cr.translate(cx, cy);
                    cr.rotate(a);
                    cr.translate(-cx, -cy);
                } else {
                    cr.rotate(a);
                }
            }
            "scale" => {
                let sx = nums.first().copied().unwrap_or(1.0);
                let sy = nums.get(1).copied().unwrap_or(sx);
                cr.scale(sx, sy);
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Geometry helpers (bezier approximations, so paths stay CTM-independent)
// ---------------------------------------------------------------------------

fn ellipse_path(cr: &cairo::Context, cx: f64, cy: f64, rx: f64, ry: f64) {
    const K: f64 = 0.5522847498307936;
    cr.move_to(cx + rx, cy);
    cr.curve_to(cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry);
    cr.curve_to(cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy);
    cr.curve_to(cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry);
    cr.curve_to(cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy);
    cr.close_path();
}

fn rect_path(cr: &cairo::Context, x: f64, y: f64, w: f64, h: f64, rx: f64, ry: f64) {
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    if rx <= 0.0 || ry <= 0.0 {
        cr.rectangle(x, y, w, h);
        return;
    }
    let rx = rx.min(w / 2.0);
    let ry = ry.min(h / 2.0);
    const K: f64 = 0.5522847498307936;
    let kx = K * rx;
    let ky = K * ry;
    cr.move_to(x + rx, y);
    cr.line_to(x + w - rx, y);
    cr.curve_to(x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry);
    cr.line_to(x + w, y + h - ry);
    cr.curve_to(
        x + w,
        y + h - ry + ky,
        x + w - rx + kx,
        y + h,
        x + w - rx,
        y + h,
    );
    cr.line_to(x + rx, y + h);
    cr.curve_to(x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry);
    cr.line_to(x, y + ry);
    cr.curve_to(x, y + ry - ky, x + rx - kx, y, x + rx, y);
    cr.close_path();
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

fn gradient_for(id: &str, bbox: (f64, f64, f64, f64)) -> Option<cairo::Pattern> {
    let def = GRADIENTS.iter().find(|d| d.id == id)?;
    let (bx, by, bw, bh) = bbox;
    let pat = match def.kind {
        GradKind::Linear { x1, y1, x2, y2 } => {
            let g =
                cairo::LinearGradient::new(bx + x1 * bw, by + y1 * bh, bx + x2 * bw, by + y2 * bh);
            for s in def.stops {
                g.add_color_stop_rgba(
                    s.offset,
                    s.r as f64 / 255.0,
                    s.g as f64 / 255.0,
                    s.b as f64 / 255.0,
                    s.opacity,
                );
            }
            (**g).clone()
        }
        GradKind::Radial => {
            if bw <= 0.0 || bh <= 0.0 {
                // Degenerate bbox: fall back to a circular gradient.
                let cx = bx + bw / 2.0;
                let cy = by + bh / 2.0;
                let r = bw.max(bh) / 2.0;
                let g = cairo::RadialGradient::new(cx, cy, 0.0, cx, cy, r);
                for s in def.stops {
                    g.add_color_stop_rgba(
                        s.offset,
                        s.r as f64 / 255.0,
                        s.g as f64 / 255.0,
                        s.b as f64 / 255.0,
                        s.opacity,
                    );
                }
                return Some((**g).clone());
            }
            // SVG objectBoundingBox radial: the unit circle maps to the bbox
            // ellipse. Emulate with a pattern matrix mapping user coords to
            // unit-square coords.
            let g = cairo::RadialGradient::new(0.5, 0.5, 0.0, 0.5, 0.5, 0.5);
            for s in def.stops {
                g.add_color_stop_rgba(
                    s.offset,
                    s.r as f64 / 255.0,
                    s.g as f64 / 255.0,
                    s.b as f64 / 255.0,
                    s.opacity,
                );
            }
            g.set_matrix(cairo::Matrix::new(
                1.0 / bw,
                0.0,
                0.0,
                1.0 / bh,
                -bx / bw,
                -by / bh,
            ));
            (**g).clone()
        }
    };
    Some(pat)
}

fn pattern_for(id: &str, px_per_unit: f64) -> Option<cairo::Pattern> {
    let def = PATTERNS.iter().find(|d| d.id == id)?;
    let s = if px_per_unit.is_finite() && px_per_unit > 0.0 {
        px_per_unit
    } else {
        1.0
    };
    let w = (def.w * s).ceil().max(1.0) as i32;
    let h = (def.h * s).ceil().max(1.0) as i32;
    let surf = cairo::ImageSurface::create(cairo::Format::ARgb32, w, h).ok()?;
    let pcr = cairo::Context::new(&surf).ok()?;
    pcr.scale(s, s);
    for n in def.nodes {
        draw_node(&pcr, n, 0.0, 0.0, s);
    }
    let pat = cairo::SurfacePattern::create(&surf);
    pat.set_extend(cairo::Extend::Repeat);
    // Pattern coords = user coords * s (tile pixels), i.e. the pattern matrix
    // maps user space (viewBox units) to pattern space (tile pixels).
    pat.set_matrix(cairo::Matrix::new(s, 0.0, 0.0, s, 0.0, 0.0));
    Some((*pat).clone())
}

/// Fill (then stroke, if any) the path currently built on `cr`.
/// Gradient fills use the path's fill extents as the object bounding box.
fn paint_current_path(cr: &cairo::Context, paint: &Paint, px_per_unit: f64) {
    let has_fill = !matches!(paint.fill, Fill::None);
    let has_stroke = paint.stroke.is_some();
    if has_fill {
        let bbox = cr.fill_extents().unwrap_or((0.0, 0.0, 0.0, 0.0));
        let alpha = paint.opacity * paint.fill_opacity;
        let filled = match paint.fill {
            Fill::Rgb(r, g, b) => {
                cr.set_source_rgba(r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0, alpha);
                if has_stroke {
                    let _ = cr.fill_preserve();
                } else {
                    let _ = cr.fill();
                }
                true
            }
            Fill::Grad(id) => match gradient_for(id, bbox) {
                Some(g) => {
                    let _ = cr.set_source(&g);
                    if has_stroke {
                        let _ = cr.fill_preserve();
                    } else {
                        let _ = cr.fill();
                    }
                    true
                }
                None => {
                    if !has_stroke {
                        cr.new_path();
                    }
                    false
                }
            },
            Fill::Pattern(id) => match pattern_for(id, px_per_unit) {
                Some(p) => {
                    let _ = cr.set_source(&p);
                    if has_stroke {
                        let _ = cr.fill_preserve();
                    } else {
                        let _ = cr.fill();
                    }
                    true
                }
                None => {
                    if !has_stroke {
                        cr.new_path();
                    }
                    false
                }
            },
            Fill::None => false,
        };
        let _ = filled;
    }
    if let Some(st) = paint.stroke {
        cr.set_source_rgba(
            st.rgb.0 as f64 / 255.0,
            st.rgb.1 as f64 / 255.0,
            st.rgb.2 as f64 / 255.0,
            paint.opacity,
        );
        cr.set_line_width(st.width);
        cr.set_line_cap(match st.cap {
            Cap::Round => cairo::LineCap::Round,
            Cap::Square => cairo::LineCap::Square,
            Cap::Butt => cairo::LineCap::Butt,
        });
        cr.set_line_join(match st.join {
            Join::Round => cairo::LineJoin::Round,
            Join::Bevel => cairo::LineJoin::Bevel,
            Join::Miter => cairo::LineJoin::Miter,
        });
        if st.dash.is_empty() {
            cr.set_dash(&[], 0.0);
        } else {
            cr.set_dash(st.dash, 0.0);
        }
        let _ = cr.stroke();
    } else if !has_fill {
        cr.new_path();
    }
}

fn draw_text(
    cr: &cairo::Context,
    x: f64,
    y: f64,
    size: f64,
    bold: bool,
    middle: bool,
    rgb: (u8, u8, u8),
    opacity: f64,
    text: &str,
) {
    cr.select_font_face(
        "Sans",
        cairo::FontSlant::Normal,
        if bold {
            cairo::FontWeight::Bold
        } else {
            cairo::FontWeight::Normal
        },
    );
    cr.set_font_size(size);
    let mut tx = x;
    if middle {
        if let Ok(ext) = cr.text_extents(text) {
            tx = x - ext.width() / 2.0 - ext.x_bearing();
        }
    }
    cr.move_to(tx, y);
    cr.set_source_rgba(
        rgb.0 as f64 / 255.0,
        rgb.1 as f64 / 255.0,
        rgb.2 as f64 / 255.0,
        opacity,
    );
    let _ = cr.show_text(text);
}

fn draw_node(cr: &cairo::Context, node: &Node, px: f64, py: f64, px_per_unit: f64) {
    match node {
        Node::Group {
            transform,
            look,
            children,
        } => {
            let _ = cr.save();
            if *look {
                // Cursor-follow: shift the eye group toward the pupil offset.
                // (JS gaze moves the face up to ~4.5 x 3 units; the pupil range
                // [-1, 1] maps to a comparable shift here.)
                cr.translate(px * 5.0, py * 3.0);
            }
            if !transform.is_empty() {
                apply_transform(cr, transform);
            }
            for c in *children {
                draw_node(cr, c, px, py, px_per_unit);
            }
            let _ = cr.restore();
        }
        Node::Path { d, paint } => {
            cr.new_path();
            draw_path(cr, d);
            paint_current_path(cr, paint, px_per_unit);
        }
        Node::Circle { cx, cy, r, paint } => {
            cr.new_path();
            ellipse_path(cr, *cx, *cy, *r, *r);
            paint_current_path(cr, paint, px_per_unit);
        }
        Node::Ellipse {
            cx,
            cy,
            rx,
            ry,
            paint,
        } => {
            cr.new_path();
            ellipse_path(cr, *cx, *cy, *rx, *ry);
            paint_current_path(cr, paint, px_per_unit);
        }
        Node::Rect {
            x,
            y,
            w,
            h,
            rx,
            ry,
            paint,
        } => {
            cr.new_path();
            rect_path(cr, *x, *y, *w, *h, *rx, *ry);
            paint_current_path(cr, paint, px_per_unit);
        }
        Node::Text {
            x,
            y,
            size,
            bold,
            middle,
            rgb,
            opacity,
            text,
        } => {
            draw_text(cr, *x, *y, *size, *bold, *middle, *rgb, *opacity, text);
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Draw the mascot centered in a `size` x `size` box (the JS `lg` viewBox,
/// -150..150, scaled to fit). `pose` is a pose name (or a pill status, which
/// is resolved via `pose_for`); `decor` is a decor key or `"auto"`; `costume`
/// is a costume key or `""`/`"none"` (a known costume overrides `decor`);
/// `pupil` is the eye offset in [-1, 1] (clamped, (0, 0) = centered eyes).
pub fn draw_mascot(
    cr: &cairo::Context,
    pose: &str,
    decor: &str,
    costume: &str,
    size: f64,
    pupil: (f64, f64),
) {
    if !(size > 0.0) || !size.is_finite() {
        return;
    }
    let px = pupil.0.clamp(-1.0, 1.0);
    let py = pupil.1.clamp(-1.0, 1.0);
    let key = resolve_key(decor, costume);
    let slots = slots_for(key);
    let p = pose_for(pose, "");
    let face_key = if p == "idle" { mood_for(key) } else { p };
    let face = face_nodes(face_key);
    let acc = acc_nodes(p);
    let paws = paws_for(p);
    let unit = size / 300.0;
    let _ = cr.save();
    cr.translate(size / 2.0, size / 2.0);
    cr.scale(unit, unit);
    // Assembly order mirrors layers() + mascotSvgString in mascot.js:
    // ambient, ground shadow, body, neck, paws, face, decor eyes, head, acc.
    for n in slots.amb {
        draw_node(cr, n, px, py, unit);
    }
    cr.new_path();
    ellipse_path(cr, 0.0, 72.0, 100.0, 16.0);
    paint_current_path(cr, &SHADOW_PAINT, unit);
    for n in BODY {
        draw_node(cr, n, px, py, unit);
    }
    for n in slots.neck {
        draw_node(cr, n, px, py, unit);
    }
    for n in paws {
        draw_node(cr, n, px, py, unit);
    }
    for n in face {
        draw_node(cr, n, px, py, unit);
    }
    for n in slots.eyes {
        draw_node(cr, n, px, py, unit);
    }
    for n in slots.head {
        draw_node(cr, n, px, py, unit);
    }
    for n in acc {
        draw_node(cr, n, px, py, unit);
    }
    let _ = cr.restore();
}

// ---------------------------------------------------------------------------
// Generated tables — verbatim art data from dae-captain/ui/mascot.js @ 2be3795d.
// Do not hand-edit: regenerate from /tmp/mascot-dump.mjs + this generator.
// ---------------------------------------------------------------------------

pub static BODY: &[Node] = &[
    Node::Path {
        d: "M-82-25L-70-98-22-66Z",
        paint: Paint {
            fill: Fill::Grad("dm-hood"),
            fill_opacity: 1.0,
            stroke: None,
            opacity: 1.0,
        },
    },
    Node::Path {
        d: "M-72-45L-67-82-42-64Z",
        paint: Paint {
            fill: Fill::Rgb(167, 139, 250),
            fill_opacity: 1.0,
            stroke: None,
            opacity: 1.0,
        },
    },
    Node::Path {
        d: "M82-25L70-98 22-66Z",
        paint: Paint {
            fill: Fill::Grad("dm-hood"),
            fill_opacity: 1.0,
            stroke: None,
            opacity: 1.0,
        },
    },
    Node::Path {
        d: "M72-45L67-82 42-64Z",
        paint: Paint {
            fill: Fill::Rgb(167, 139, 250),
            fill_opacity: 1.0,
            stroke: None,
            opacity: 1.0,
        },
    },
    Node::Ellipse {
        cx: 0.0,
        cy: 55.0,
        rx: 72.0,
        ry: 30.0,
        paint: Paint {
            fill: Fill::Rgb(47, 53, 201),
            fill_opacity: 1.0,
            stroke: None,
            opacity: 1.0,
        },
    },
    Node::Ellipse {
        cx: 0.0,
        cy: 0.0,
        rx: 92.0,
        ry: 72.0,
        paint: Paint {
            fill: Fill::Grad("dm-hood"),
            fill_opacity: 1.0,
            stroke: None,
            opacity: 1.0,
        },
    },
    Node::Ellipse {
        cx: 0.0,
        cy: 6.0,
        rx: 75.0,
        ry: 56.0,
        paint: Paint {
            fill: Fill::Grad("dm-face"),
            fill_opacity: 1.0,
            stroke: None,
            opacity: 1.0,
        },
    },
];

pub static PAWS_BASE: &[Node] = &[
    Node::Circle {
        cx: -58.0,
        cy: 58.0,
        r: 15.0,
        paint: Paint {
            fill: Fill::Grad("dm-paw"),
            fill_opacity: 1.0,
            stroke: None,
            opacity: 1.0,
        },
    },
    Node::Circle {
        cx: 58.0,
        cy: 58.0,
        r: 15.0,
        paint: Paint {
            fill: Fill::Grad("dm-paw"),
            fill_opacity: 1.0,
            stroke: None,
            opacity: 1.0,
        },
    },
];

pub static PAWS_LEFT: &[Node] = &[Node::Circle {
    cx: -58.0,
    cy: 58.0,
    r: 15.0,
    paint: Paint {
        fill: Fill::Grad("dm-paw"),
        fill_opacity: 1.0,
        stroke: None,
        opacity: 1.0,
    },
}];

pub static PAWS_RIGHT: &[Node] = &[Node::Circle {
    cx: 58.0,
    cy: 58.0,
    r: 15.0,
    paint: Paint {
        fill: Fill::Grad("dm-paw"),
        fill_opacity: 1.0,
        stroke: None,
        opacity: 1.0,
    },
}];

pub static FACES: &[(&str, &[Node])] = &[
    (
        "idle",
        &[
            Node::Circle {
                cx: -30.0,
                cy: 2.0,
                r: 11.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 30.0,
                cy: 2.0,
                r: 11.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -33.0,
                cy: -2.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 27.0,
                cy: -2.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-9 21q4.5 5 9 0q4.5 5 9 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "ready",
        &[
            Node::Path {
                d: "M-46-17L-16-12M46-17L16-12",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (143, 176, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -28.0,
                cy: 3.0,
                r: 11.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 28.0,
                cy: 3.0,
                r: 11.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -31.0,
                cy: -1.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 25.0,
                cy: -1.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-9 21q9 8 18-4",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "dreamy",
        &[
            Node::Ellipse {
                cx: -54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 143, 184),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.45,
                },
            },
            Node::Ellipse {
                cx: 54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 143, 184),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.45,
                },
            },
            Node::Path {
                d: "M-12 19q12 16 24 0Z",
                paint: Paint {
                    fill: Fill::Rgb(124, 92, 255),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (124, 92, 255),
                        width: 1.5,
                        cap: Cap::Butt,
                        join: Join::Round,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-42 6q12-14 24 0M18 6q12-14 24 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (199, 210, 255),
                        width: 4.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "translate(86 -30) scale(.9)",
                look: false,
                children: &[Node::Path {
                    d: "M0 7C-16-5-9-16 0-9C9-16 16-5 0 7Z",
                    paint: Paint {
                        fill: Fill::Rgb(255, 143, 184),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
            Node::Group {
                transform: "translate(-90 -20) scale(.6)",
                look: false,
                children: &[Node::Path {
                    d: "M0 7C-16-5-9-16 0-9C9-16 16-5 0 7Z",
                    paint: Paint {
                        fill: Fill::Rgb(255, 143, 184),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
        ],
    ),
    (
        "grin",
        &[
            Node::Ellipse {
                cx: -54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 157, 122),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.5,
                },
            },
            Node::Ellipse {
                cx: 54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 157, 122),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.5,
                },
            },
            Node::Path {
                d: "M-18 19q18 22 36 0Z",
                paint: Paint {
                    fill: Fill::Rgb(124, 92, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Rect {
                x: -4.0,
                y: 19.0,
                w: 8.0,
                h: 5.0,
                rx: 1.5,
                ry: 1.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M70 -8q6 10 0 14q-6-4 0-14Z",
                paint: Paint {
                    fill: Fill::Rgb(122, 215, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -30.0,
                cy: 2.0,
                r: 9.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 30.0,
                cy: 2.0,
                r: 9.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -33.0,
                cy: -2.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 27.0,
                cy: -2.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "cozy",
        &[
            Node::Ellipse {
                cx: -54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 157, 122),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.5,
                },
            },
            Node::Ellipse {
                cx: 54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 157, 122),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.5,
                },
            },
            Node::Path {
                d: "M-9 21q9 7 18 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-42 2q12 12 24 0M18 2q12 12 24 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (199, 210, 255),
                        width: 4.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "devious",
        &[
            Node::Path {
                d: "M-46-8L-14 4-18 15-44 10Z",
                paint: Paint {
                    fill: Fill::Rgb(255, 226, 122),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M46-8L14 4 18 15 44 10Z",
                paint: Paint {
                    fill: Fill::Rgb(255, 226, 122),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Ellipse {
                cx: -27.0,
                cy: 9.0,
                rx: 2.5,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(26, 18, 64),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Ellipse {
                cx: 27.0,
                cy: 9.0,
                rx: 2.5,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(26, 18, 64),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-22 17Q0 40 22 17Q0 25-22 17Z",
                paint: Paint {
                    fill: Fill::Rgb(42, 21, 96),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.0,
                        cap: Cap::Butt,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-12 20l4 7 4-5M12 20l-4 7-4-5",
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "shiver",
        &[
            Node::Ellipse {
                cx: -54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(122, 184, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.5,
                },
            },
            Node::Ellipse {
                cx: 54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(122, 184, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.5,
                },
            },
            Node::Path {
                d: "M-14 25q3.5-6 7 0t7 0t7 0t7 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-44-4l16 8-16 8M44-4l-16 8 16 8",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (199, 210, 255),
                        width: 4.5,
                        cap: Cap::Round,
                        join: Join::Round,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 26.0,
                cy: 38.0,
                r: 4.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.7,
                },
            },
            Node::Circle {
                cx: 38.0,
                cy: 45.0,
                r: 6.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.6,
                },
            },
            Node::Circle {
                cx: 52.0,
                cy: 52.0,
                r: 8.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.5,
                },
            },
        ],
    ),
    (
        "sparkle",
        &[
            Node::Ellipse {
                cx: -54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 143, 208),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.45,
                },
            },
            Node::Ellipse {
                cx: 54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 143, 208),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.45,
                },
            },
            Node::Path {
                d: "M-14 19q14 18 28 0Z",
                paint: Paint {
                    fill: Fill::Rgb(124, 92, 255),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (124, 92, 255),
                        width: 1.5,
                        cap: Cap::Butt,
                        join: Join::Round,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -30.0,
                cy: 0.0,
                r: 13.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 30.0,
                cy: 0.0,
                r: 13.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -34.0,
                cy: -4.0,
                r: 4.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 26.0,
                cy: -4.0,
                r: 4.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -25.0,
                cy: 5.0,
                r: 2.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 35.0,
                cy: 5.0,
                r: 2.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "translate(-62 -22) scale(0.7)",
                look: false,
                children: &[Node::Path {
                    d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                    paint: Paint {
                        fill: Fill::Rgb(154, 168, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
        ],
    ),
    (
        "love",
        &[
            Node::Ellipse {
                cx: -54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 143, 184),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.55,
                },
            },
            Node::Ellipse {
                cx: 54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 143, 184),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.55,
                },
            },
            Node::Path {
                d: "M-10 20q10 10 20 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "translate(-30 2) scale(1.25)",
                look: false,
                children: &[Node::Path {
                    d: "M0 7C-16-5-9-16 0-9C9-16 16-5 0 7Z",
                    paint: Paint {
                        fill: Fill::Rgb(255, 92, 138),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
            Node::Group {
                transform: "translate(30 2) scale(1.25)",
                look: false,
                children: &[Node::Path {
                    d: "M0 7C-16-5-9-16 0-9C9-16 16-5 0 7Z",
                    paint: Paint {
                        fill: Fill::Rgb(255, 92, 138),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
        ],
    ),
    (
        "thinking",
        &[
            Node::Path {
                d: "M-46-20L-16-11M46-20L16-11",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "",
                look: true,
                children: &[
                    Node::Circle {
                        cx: -26.0,
                        cy: -2.0,
                        r: 11.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 34.0,
                        cy: -2.0,
                        r: 11.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: -23.0,
                        cy: -7.0,
                        r: 3.5,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 37.0,
                        cy: -7.0,
                        r: 3.5,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Path {
                d: "M-8 24q8-4 16 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "working",
        &[
            Node::Path {
                d: "M-44-8L-14 4-18 15-42 10Z",
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M44-8L14 4 18 15 42 10Z",
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-8 22q8 4 16 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "verifying",
        &[
            Node::Path {
                d: "M-46-14h30M46-14H16",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (79, 209, 197),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "",
                look: true,
                children: &[
                    Node::Ellipse {
                        cx: -28.0,
                        cy: 4.0,
                        rx: 12.0,
                        ry: 7.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Ellipse {
                        cx: 28.0,
                        cy: 4.0,
                        rx: 12.0,
                        ry: 7.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: -31.0,
                        cy: 2.0,
                        r: 3.0,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 25.0,
                        cy: 2.0,
                        r: 3.0,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Path {
                d: "M-7 23h14",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "fixing",
        &[
            Node::Path {
                d: "M-44-8L-14 4-18 15-42 10Z",
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M44-8L14 4 18 15 42 10Z",
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-10 22l4-3 4 3 4-3 4 3 4-3",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "permission",
        &[
            Node::Path {
                d: "M-44-18q14-8 28 0M16-18q14-8 28 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -30.0,
                cy: 2.0,
                r: 11.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 30.0,
                cy: 2.0,
                r: 11.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -33.0,
                cy: -2.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 27.0,
                cy: -2.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Ellipse {
                cx: 0.0,
                cy: 24.0,
                rx: 4.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Butt,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "paused",
        &[
            Node::Path {
                d: "M-42 5h22M20 5h22",
                paint: Paint {
                    fill: Fill::Rgb(0, 0, 0),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (199, 210, 255),
                        width: 4.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-7 23h14",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "queued",
        &[
            Node::Group {
                transform: "",
                look: true,
                children: &[
                    Node::Circle {
                        cx: -24.0,
                        cy: 2.0,
                        r: 11.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 36.0,
                        cy: 2.0,
                        r: 11.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: -20.0,
                        cy: -2.0,
                        r: 3.5,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 40.0,
                        cy: -2.0,
                        r: 3.5,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Ellipse {
                cx: 0.0,
                cy: 23.0,
                rx: 4.0,
                ry: 2.5,
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Butt,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "done",
        &[
            Node::Path {
                d: "M-42 6q12-14 24 0M18 6q12-14 24 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (199, 210, 255),
                        width: 4.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-12 22q12 18 24 0Z",
                paint: Paint {
                    fill: Fill::Rgb(124, 92, 255),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (124, 92, 255),
                        width: 1.5,
                        cap: Cap::Butt,
                        join: Join::Round,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "error",
        &[
            Node::Path {
                d: "M-14 25q3.5-6 7 0t7 0t7 0t7 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-42-4l18 16M-24-4l-18 16M24-4l18 16M42-4l-18 16",
                paint: Paint {
                    fill: Fill::Rgb(0, 0, 0),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (255, 138, 154),
                        width: 4.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "sleep",
        &[
            Node::Path {
                d: "M-42 4q12 12 24 0M18 4q12 12 24 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (199, 210, 255),
                        width: 4.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-6 24q6 4 12 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "coding",
        &[
            Node::Path {
                d: "M-46-16L-16-12M46-16L16-12",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (143, 176, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "",
                look: true,
                children: &[
                    Node::Circle {
                        cx: -24.0,
                        cy: 8.0,
                        r: 10.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 32.0,
                        cy: 8.0,
                        r: 10.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: -22.0,
                        cy: 12.0,
                        r: 3.0,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 34.0,
                        cy: 12.0,
                        r: 3.0,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Path {
                d: "M-8 22q9 7 17-3",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "document",
        &[
            Node::Path {
                d: "M-44-2q14-9 28 0M16-2q14-9 28 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "",
                look: true,
                children: &[
                    Node::Ellipse {
                        cx: -30.0,
                        cy: 4.0,
                        rx: 12.0,
                        ry: 6.5,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Ellipse {
                        cx: 30.0,
                        cy: 4.0,
                        rx: 12.0,
                        ry: 6.5,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Path {
                d: "M-8 22q8 6 16 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "research",
        &[
            Node::Path {
                d: "M-44-22q14-10 28-3",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M14-30q16-10 30 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "",
                look: true,
                children: &[
                    Node::Circle {
                        cx: -28.0,
                        cy: 2.0,
                        r: 10.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 32.0,
                        cy: 0.0,
                        r: 15.0,
                        paint: Paint {
                            fill: Fill::Grad("dm-eye"),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: -31.0,
                        cy: -2.0,
                        r: 3.0,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 27.0,
                        cy: -5.0,
                        r: 5.0,
                        paint: Paint {
                            fill: Fill::Rgb(255, 255, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Ellipse {
                cx: 0.0,
                cy: 25.0,
                rx: 5.0,
                ry: 6.0,
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Butt,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "spreadsheet",
        &[
            Node::Path {
                d: "M14-28q16-9 30 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -29.0,
                cy: 2.0,
                r: 11.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 29.0,
                cy: 2.0,
                r: 11.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -32.0,
                cy: -2.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 26.0,
                cy: -2.0,
                r: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-9 21q9 7 18 0",
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 2.5,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "slide",
        &[
            Node::Ellipse {
                cx: -54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 143, 208),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.45,
                },
            },
            Node::Ellipse {
                cx: 54.0,
                cy: 22.0,
                rx: 9.0,
                ry: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 143, 208),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.45,
                },
            },
            Node::Path {
                d: "M-14 19q14 18 28 0Z",
                paint: Paint {
                    fill: Fill::Rgb(124, 92, 255),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (124, 92, 255),
                        width: 1.5,
                        cap: Cap::Butt,
                        join: Join::Round,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -30.0,
                cy: 0.0,
                r: 13.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 30.0,
                cy: 0.0,
                r: 13.0,
                paint: Paint {
                    fill: Fill::Grad("dm-eye"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -34.0,
                cy: -4.0,
                r: 4.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 26.0,
                cy: -4.0,
                r: 4.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -25.0,
                cy: 5.0,
                r: 2.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 35.0,
                cy: 5.0,
                r: 2.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 255, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "translate(-62 -22) scale(0.7)",
                look: false,
                children: &[Node::Path {
                    d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                    paint: Paint {
                        fill: Fill::Rgb(154, 168, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
        ],
    ),
];

pub static ACCS: &[(&str, &[Node])] = &[
    (
        "idle",
        &[Node::Group {
            transform: "translate(78 28)",
            look: false,
            children: &[
                Node::Path {
                    d: "M-5-20q-6-8 0-14q6-6 0-14M7-20q-6-8 0-14",
                    paint: Paint {
                        fill: Fill::None,
                        fill_opacity: 1.0,
                        stroke: Some(Stroke {
                            rgb: (165, 180, 255),
                            width: 3.5,
                            cap: Cap::Round,
                            join: Join::Miter,
                            dash: &[],
                        }),
                        opacity: 1.0,
                    },
                },
                Node::Path {
                    d: "M14-6q15 0 15 11q0 11-15 11",
                    paint: Paint {
                        fill: Fill::None,
                        fill_opacity: 1.0,
                        stroke: Some(Stroke {
                            rgb: (215, 219, 255),
                            width: 5.0,
                            cap: Cap::Butt,
                            join: Join::Miter,
                            dash: &[],
                        }),
                        opacity: 1.0,
                    },
                },
                Node::Rect {
                    x: -16.0,
                    y: -16.0,
                    w: 32.0,
                    h: 36.0,
                    rx: 6.0,
                    ry: 6.0,
                    paint: Paint {
                        fill: Fill::Rgb(215, 219, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
                Node::Ellipse {
                    cx: 0.0,
                    cy: -16.0,
                    rx: 16.0,
                    ry: 5.0,
                    paint: Paint {
                        fill: Fill::Rgb(122, 74, 46),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
                Node::Circle {
                    cx: -12.0,
                    cy: 22.0,
                    r: 15.0,
                    paint: Paint {
                        fill: Fill::Grad("dm-paw"),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
            ],
        }],
    ),
    (
        "thinking",
        &[
            Node::Circle {
                cx: -22.0,
                cy: 52.0,
                r: 16.0,
                paint: Paint {
                    fill: Fill::Grad("dm-paw"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Ellipse {
                cx: 62.0,
                cy: -102.0,
                rx: 26.0,
                ry: 8.0,
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 5.0,
                        cap: Cap::Butt,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 98.0,
                cy: -72.0,
                r: 8.0,
                paint: Paint {
                    fill: Fill::Rgb(91, 108, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 84.0,
                cy: -48.0,
                r: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(91, 108, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Text {
                x: 104.0,
                y: -86.0,
                size: 26.0,
                bold: true,
                middle: false,
                rgb: (165, 180, 255),
                opacity: 1.0,
                text: "?",
            },
        ],
    ),
    (
        "working",
        &[
            Node::Group {
                transform: "translate(36 42)",
                look: false,
                children: &[Node::Group {
                    transform: "rotate(-8)",
                    look: false,
                    children: &[
                        Node::Rect {
                            x: -40.0,
                            y: -40.0,
                            w: 80.0,
                            h: 56.0,
                            rx: 6.0,
                            ry: 6.0,
                            paint: Paint {
                                fill: Fill::Rgb(74, 79, 184),
                                fill_opacity: 1.0,
                                stroke: Some(Stroke {
                                    rgb: (138, 147, 255),
                                    width: 2.0,
                                    cap: Cap::Butt,
                                    join: Join::Miter,
                                    dash: &[],
                                }),
                                opacity: 1.0,
                            },
                        },
                        Node::Group {
                            transform: "translate(0 -12)",
                            look: false,
                            children: &[Node::Path {
                                d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                                paint: Paint {
                                    fill: Fill::Rgb(165, 180, 255),
                                    fill_opacity: 1.0,
                                    stroke: None,
                                    opacity: 1.0,
                                },
                            }],
                        },
                        Node::Rect {
                            x: -50.0,
                            y: 16.0,
                            w: 100.0,
                            h: 8.0,
                            rx: 4.0,
                            ry: 4.0,
                            paint: Paint {
                                fill: Fill::Rgb(59, 63, 156),
                                fill_opacity: 1.0,
                                stroke: None,
                                opacity: 1.0,
                            },
                        },
                    ],
                }],
            },
            Node::Text {
                x: 78.0,
                y: -68.0,
                size: 30.0,
                bold: true,
                middle: false,
                rgb: (124, 140, 255),
                opacity: 1.0,
                text: "</>",
            },
        ],
    ),
    (
        "verifying",
        &[Node::Group {
            transform: "translate(80 36) rotate(6)",
            look: false,
            children: &[
                Node::Rect {
                    x: -26.0,
                    y: -34.0,
                    w: 52.0,
                    h: 68.0,
                    rx: 5.0,
                    ry: 5.0,
                    paint: Paint {
                        fill: Fill::Rgb(215, 219, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
                Node::Rect {
                    x: -10.0,
                    y: -40.0,
                    w: 20.0,
                    h: 10.0,
                    rx: 3.0,
                    ry: 3.0,
                    paint: Paint {
                        fill: Fill::Rgb(111, 124, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
                Node::Path {
                    d: "M-18 -14l4 4 8-8",
                    paint: Paint {
                        fill: Fill::None,
                        fill_opacity: 1.0,
                        stroke: Some(Stroke {
                            rgb: (47, 184, 159),
                            width: 3.5,
                            cap: Cap::Round,
                            join: Join::Round,
                            dash: &[],
                        }),
                        opacity: 1.0,
                    },
                },
                Node::Path {
                    d: "M-4 -14h18",
                    paint: Paint {
                        fill: Fill::Rgb(0, 0, 0),
                        fill_opacity: 1.0,
                        stroke: Some(Stroke {
                            rgb: (138, 147, 255),
                            width: 4.0,
                            cap: Cap::Round,
                            join: Join::Miter,
                            dash: &[],
                        }),
                        opacity: 1.0,
                    },
                },
                Node::Path {
                    d: "M-18 2l4 4 8-8",
                    paint: Paint {
                        fill: Fill::None,
                        fill_opacity: 1.0,
                        stroke: Some(Stroke {
                            rgb: (47, 184, 159),
                            width: 3.5,
                            cap: Cap::Round,
                            join: Join::Round,
                            dash: &[],
                        }),
                        opacity: 1.0,
                    },
                },
                Node::Path {
                    d: "M-4 2h18",
                    paint: Paint {
                        fill: Fill::Rgb(0, 0, 0),
                        fill_opacity: 1.0,
                        stroke: Some(Stroke {
                            rgb: (138, 147, 255),
                            width: 4.0,
                            cap: Cap::Round,
                            join: Join::Miter,
                            dash: &[],
                        }),
                        opacity: 1.0,
                    },
                },
                Node::Path {
                    d: "M-18 18l4 4 8-8",
                    paint: Paint {
                        fill: Fill::None,
                        fill_opacity: 1.0,
                        stroke: Some(Stroke {
                            rgb: (47, 184, 159),
                            width: 3.5,
                            cap: Cap::Round,
                            join: Join::Round,
                            dash: &[],
                        }),
                        opacity: 1.0,
                    },
                },
                Node::Path {
                    d: "M-4 18h18",
                    paint: Paint {
                        fill: Fill::Rgb(0, 0, 0),
                        fill_opacity: 1.0,
                        stroke: Some(Stroke {
                            rgb: (138, 147, 255),
                            width: 4.0,
                            cap: Cap::Round,
                            join: Join::Miter,
                            dash: &[],
                        }),
                        opacity: 1.0,
                    },
                },
            ],
        }],
    ),
    (
        "fixing",
        &[
            Node::Group {
                transform: "translate(82 30)",
                look: false,
                children: &[Node::Group {
                    transform: "rotate(35)",
                    look: false,
                    children: &[
                        Node::Rect {
                            x: -4.0,
                            y: -30.0,
                            w: 8.0,
                            h: 62.0,
                            rx: 4.0,
                            ry: 4.0,
                            paint: Paint {
                                fill: Fill::Rgb(183, 191, 255),
                                fill_opacity: 1.0,
                                stroke: None,
                                opacity: 1.0,
                            },
                        },
                        Node::Circle {
                            cx: 0.0,
                            cy: -32.0,
                            r: 11.0,
                            paint: Paint {
                                fill: Fill::Rgb(183, 191, 255),
                                fill_opacity: 1.0,
                                stroke: None,
                                opacity: 1.0,
                            },
                        },
                        Node::Rect {
                            x: -3.0,
                            y: -48.0,
                            w: 6.0,
                            h: 14.0,
                            rx: 0.0,
                            ry: 0.0,
                            paint: Paint {
                                fill: Fill::Rgb(11, 12, 42),
                                fill_opacity: 1.0,
                                stroke: None,
                                opacity: 1.0,
                            },
                        },
                    ],
                }],
            },
            Node::Group {
                transform: "translate(-96 -62)",
                look: false,
                children: &[
                    Node::Circle {
                        cx: 0.0,
                        cy: 0.0,
                        r: 11.0,
                        paint: Paint {
                            fill: Fill::None,
                            fill_opacity: 1.0,
                            stroke: Some(Stroke {
                                rgb: (255, 184, 74),
                                width: 6.0,
                                cap: Cap::Butt,
                                join: Join::Miter,
                                dash: &[4.3, 4.3],
                            }),
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 0.0,
                        cy: 0.0,
                        r: 5.0,
                        paint: Paint {
                            fill: Fill::None,
                            fill_opacity: 1.0,
                            stroke: Some(Stroke {
                                rgb: (255, 184, 74),
                                width: 3.0,
                                cap: Cap::Butt,
                                join: Join::Miter,
                                dash: &[],
                            }),
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Group {
                transform: "translate(100 -30) scale(1)",
                look: false,
                children: &[Node::Path {
                    d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                    paint: Paint {
                        fill: Fill::Rgb(255, 214, 107),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
            Node::Path {
                d: "M-72 -14q6 10 0 14q-6-4 0-14Z",
                paint: Paint {
                    fill: Fill::Rgb(122, 215, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "permission",
        &[
            Node::Group {
                transform: "translate(66 40)",
                look: false,
                children: &[
                    Node::Path {
                        d: "M0-34L30-22V8Q30 30 0 44Q-30 30-30 8V-22Z",
                        paint: Paint {
                            fill: Fill::Grad("dm-shd"),
                            fill_opacity: 1.0,
                            stroke: Some(Stroke {
                                rgb: (196, 188, 255),
                                width: 2.0,
                                cap: Cap::Butt,
                                join: Join::Miter,
                                dash: &[],
                            }),
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 0.0,
                        cy: -3.0,
                        r: 7.0,
                        paint: Paint {
                            fill: Fill::Rgb(18, 16, 58),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Rect {
                        x: -2.5,
                        y: 0.0,
                        w: 5.0,
                        h: 16.0,
                        rx: 0.0,
                        ry: 0.0,
                        paint: Paint {
                            fill: Fill::Rgb(18, 16, 58),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Rect {
                x: 82.0,
                y: -92.0,
                w: 7.0,
                h: 26.0,
                rx: 3.5,
                ry: 3.5,
                paint: Paint {
                    fill: Fill::Rgb(139, 123, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 85.5,
                cy: -56.0,
                r: 4.5,
                paint: Paint {
                    fill: Fill::Rgb(139, 123, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "paused",
        &[
            Node::Group {
                transform: "translate(92 -62)",
                look: false,
                children: &[
                    Node::Circle {
                        cx: 0.0,
                        cy: 0.0,
                        r: 19.0,
                        paint: Paint {
                            fill: Fill::Rgb(35, 38, 106),
                            fill_opacity: 1.0,
                            stroke: Some(Stroke {
                                rgb: (140, 147, 217),
                                width: 2.5,
                                cap: Cap::Butt,
                                join: Join::Miter,
                                dash: &[],
                            }),
                            opacity: 1.0,
                        },
                    },
                    Node::Rect {
                        x: -8.0,
                        y: -9.0,
                        w: 5.5,
                        h: 18.0,
                        rx: 2.0,
                        ry: 2.0,
                        paint: Paint {
                            fill: Fill::Rgb(199, 210, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Rect {
                        x: 2.5,
                        y: -9.0,
                        w: 5.5,
                        h: 18.0,
                        rx: 2.0,
                        ry: 2.0,
                        paint: Paint {
                            fill: Fill::Rgb(199, 210, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Text {
                x: -104.0,
                y: -58.0,
                size: 22.0,
                bold: true,
                middle: false,
                rgb: (140, 147, 217),
                opacity: 1.0,
                text: "z",
            },
            Node::Text {
                x: -90.0,
                y: -78.0,
                size: 16.0,
                bold: true,
                middle: false,
                rgb: (140, 147, 217),
                opacity: 1.0,
                text: "z",
            },
        ],
    ),
    (
        "queued",
        &[
            Node::Group {
                transform: "translate(94 14)",
                look: false,
                children: &[
                    Node::Path {
                        d: "M-12-20h24l-9 20 9 20h-24l9-20Z",
                        paint: Paint {
                            fill: Fill::Rgb(35, 38, 106),
                            fill_opacity: 1.0,
                            stroke: Some(Stroke {
                                rgb: (183, 191, 255),
                                width: 3.0,
                                cap: Cap::Butt,
                                join: Join::Miter,
                                dash: &[],
                            }),
                            opacity: 1.0,
                        },
                    },
                    Node::Path {
                        d: "M-6-14h12l-6 10Z",
                        paint: Paint {
                            fill: Fill::Rgb(255, 214, 107),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Group {
                transform: "translate(106 -50)",
                look: false,
                children: &[
                    Node::Circle {
                        cx: 0.0,
                        cy: 0.0,
                        r: 13.0,
                        paint: Paint {
                            fill: Fill::Rgb(124, 77, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Text {
                        x: 0.0,
                        y: 5.0,
                        size: 15.0,
                        bold: true,
                        middle: true,
                        rgb: (255, 255, 255),
                        opacity: 1.0,
                        text: "2",
                    },
                ],
            },
        ],
    ),
    (
        "done",
        &[
            Node::Circle {
                cx: -92.0,
                cy: -2.0,
                r: 16.0,
                paint: Paint {
                    fill: Fill::Grad("dm-paw"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: -92.0,
                cy: 0.0,
                r: 6.0,
                paint: Paint {
                    fill: Fill::Rgb(106, 92, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 92.0,
                cy: -2.0,
                r: 16.0,
                paint: Paint {
                    fill: Fill::Grad("dm-paw"),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 92.0,
                cy: 0.0,
                r: 6.0,
                paint: Paint {
                    fill: Fill::Rgb(106, 92, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "translate(98 -82) scale(1.4)",
                look: false,
                children: &[Node::Path {
                    d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                    paint: Paint {
                        fill: Fill::Rgb(255, 255, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
            Node::Group {
                transform: "translate(-100 -50) scale(1)",
                look: false,
                children: &[Node::Path {
                    d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                    paint: Paint {
                        fill: Fill::Rgb(154, 168, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
            Node::Group {
                transform: "translate(110 -45) scale(1)",
                look: false,
                children: &[Node::Path {
                    d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                    paint: Paint {
                        fill: Fill::Rgb(154, 168, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                }],
            },
        ],
    ),
    (
        "error",
        &[
            Node::Rect {
                x: 82.0,
                y: -92.0,
                w: 8.0,
                h: 26.0,
                rx: 4.0,
                ry: 4.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 107, 129),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 86.0,
                cy: -55.0,
                r: 5.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 107, 129),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M-76 -10q6 10 0 14q-6-4 0-14Z",
                paint: Paint {
                    fill: Fill::Rgb(122, 215, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "translate(-6 -98)",
                look: false,
                children: &[
                    Node::Group {
                        transform: "translate(28 0)",
                        look: false,
                        children: &[Node::Path {
                            d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                            paint: Paint {
                                fill: Fill::Rgb(255, 214, 107),
                                fill_opacity: 1.0,
                                stroke: None,
                                opacity: 1.0,
                            },
                        }],
                    },
                    Node::Group {
                        transform: "translate(-14 24)",
                        look: false,
                        children: &[Node::Path {
                            d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                            paint: Paint {
                                fill: Fill::Rgb(255, 214, 107),
                                fill_opacity: 1.0,
                                stroke: None,
                                opacity: 1.0,
                            },
                        }],
                    },
                    Node::Group {
                        transform: "translate(-14 -24)",
                        look: false,
                        children: &[Node::Path {
                            d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                            paint: Paint {
                                fill: Fill::Rgb(255, 214, 107),
                                fill_opacity: 1.0,
                                stroke: None,
                                opacity: 1.0,
                            },
                        }],
                    },
                ],
            },
        ],
    ),
    (
        "sleep",
        &[
            Node::Text {
                x: 70.0,
                y: -60.0,
                size: 26.0,
                bold: true,
                middle: false,
                rgb: (140, 147, 217),
                opacity: 1.0,
                text: "z",
            },
            Node::Text {
                x: 90.0,
                y: -84.0,
                size: 19.0,
                bold: true,
                middle: false,
                rgb: (140, 147, 217),
                opacity: 1.0,
                text: "z",
            },
            Node::Text {
                x: 104.0,
                y: -102.0,
                size: 14.0,
                bold: true,
                middle: false,
                rgb: (140, 147, 217),
                opacity: 1.0,
                text: "z",
            },
        ],
    ),
    (
        "coding",
        &[
            Node::Group {
                transform: "translate(36 42)",
                look: false,
                children: &[Node::Group {
                    transform: "rotate(-8)",
                    look: false,
                    children: &[
                        Node::Rect {
                            x: -40.0,
                            y: -40.0,
                            w: 80.0,
                            h: 56.0,
                            rx: 6.0,
                            ry: 6.0,
                            paint: Paint {
                                fill: Fill::Rgb(74, 79, 184),
                                fill_opacity: 1.0,
                                stroke: Some(Stroke {
                                    rgb: (138, 147, 255),
                                    width: 2.0,
                                    cap: Cap::Butt,
                                    join: Join::Miter,
                                    dash: &[],
                                }),
                                opacity: 1.0,
                            },
                        },
                        Node::Group {
                            transform: "translate(0 -12)",
                            look: false,
                            children: &[Node::Path {
                                d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z",
                                paint: Paint {
                                    fill: Fill::Rgb(165, 180, 255),
                                    fill_opacity: 1.0,
                                    stroke: None,
                                    opacity: 1.0,
                                },
                            }],
                        },
                        Node::Rect {
                            x: -50.0,
                            y: 16.0,
                            w: 100.0,
                            h: 8.0,
                            rx: 4.0,
                            ry: 4.0,
                            paint: Paint {
                                fill: Fill::Rgb(59, 63, 156),
                                fill_opacity: 1.0,
                                stroke: None,
                                opacity: 1.0,
                            },
                        },
                    ],
                }],
            },
            Node::Rect {
                x: 58.0,
                y: -100.0,
                w: 80.0,
                h: 48.0,
                rx: 6.0,
                ry: 6.0,
                paint: Paint {
                    fill: Fill::Rgb(52, 58, 158),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (117, 128, 255),
                        width: 1.0,
                        cap: Cap::Butt,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M68-86h10M84-86h40M68-74h8M82-74h30M68-62h40",
                paint: Paint {
                    fill: Fill::Rgb(0, 0, 0),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "slide",
        &[
            Node::Group {
                transform: "translate(78 40) rotate(-4)",
                look: false,
                children: &[
                    Node::Rect {
                        x: -38.0,
                        y: -28.0,
                        w: 76.0,
                        h: 56.0,
                        rx: 5.0,
                        ry: 5.0,
                        paint: Paint {
                            fill: Fill::Rgb(215, 219, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Rect {
                        x: -30.0,
                        y: -20.0,
                        w: 26.0,
                        h: 6.0,
                        rx: 2.0,
                        ry: 2.0,
                        paint: Paint {
                            fill: Fill::Rgb(111, 124, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Path {
                        d: "M-30 20L-8-2 6 12 16 2 30 20Z",
                        paint: Paint {
                            fill: Fill::Rgb(139, 147, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Circle {
                        cx: 18.0,
                        cy: -8.0,
                        r: 4.0,
                        paint: Paint {
                            fill: Fill::Rgb(111, 124, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Path {
                d: "M95-85l8 14M112-70h18",
                paint: Paint {
                    fill: Fill::Rgb(0, 0, 0),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (111, 160, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "document",
        &[
            Node::Group {
                transform: "translate(78 42) rotate(8)",
                look: false,
                children: &[
                    Node::Rect {
                        x: -26.0,
                        y: -34.0,
                        w: 52.0,
                        h: 68.0,
                        rx: 5.0,
                        ry: 5.0,
                        paint: Paint {
                            fill: Fill::Rgb(201, 205, 255),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Path {
                        d: "M-16-18h32M-16-8h32M-16 2h32M-16 12h20",
                        paint: Paint {
                            fill: Fill::Rgb(0, 0, 0),
                            fill_opacity: 1.0,
                            stroke: Some(Stroke {
                                rgb: (111, 124, 255),
                                width: 4.0,
                                cap: Cap::Round,
                                join: Join::Miter,
                                dash: &[],
                            }),
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Path {
                d: "M62-92l6 12M78-90h14",
                paint: Paint {
                    fill: Fill::Rgb(0, 0, 0),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (139, 123, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "research",
        &[
            Node::Circle {
                cx: 82.0,
                cy: -4.0,
                r: 22.0,
                paint: Paint {
                    fill: Fill::Rgb(111, 124, 255),
                    fill_opacity: 0.25,
                    stroke: Some(Stroke {
                        rgb: (183, 191, 255),
                        width: 6.0,
                        cap: Cap::Butt,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M98 12l18 22",
                paint: Paint {
                    fill: Fill::Rgb(0, 0, 0),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (117, 128, 255),
                        width: 8.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Group {
                transform: "translate(122 52) rotate(10)",
                look: false,
                children: &[
                    Node::Rect {
                        x: -24.0,
                        y: -30.0,
                        w: 48.0,
                        h: 60.0,
                        rx: 5.0,
                        ry: 5.0,
                        paint: Paint {
                            fill: Fill::Rgb(58, 63, 158),
                            fill_opacity: 1.0,
                            stroke: None,
                            opacity: 1.0,
                        },
                    },
                    Node::Path {
                        d: "M-14-14h28M-14-4h28M-14 6h18",
                        paint: Paint {
                            fill: Fill::Rgb(0, 0, 0),
                            fill_opacity: 1.0,
                            stroke: Some(Stroke {
                                rgb: (165, 180, 255),
                                width: 4.0,
                                cap: Cap::Round,
                                join: Join::Miter,
                                dash: &[],
                            }),
                            opacity: 1.0,
                        },
                    },
                ],
            },
            Node::Path {
                d: "M100-92l8 14M118-75h16",
                paint: Paint {
                    fill: Fill::Rgb(0, 0, 0),
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (165, 180, 255),
                        width: 4.0,
                        cap: Cap::Round,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
        ],
    ),
    (
        "spreadsheet",
        &[Node::Group {
            transform: "translate(82 40) rotate(-4)",
            look: false,
            children: &[
                Node::Rect {
                    x: -36.0,
                    y: -30.0,
                    w: 72.0,
                    h: 60.0,
                    rx: 5.0,
                    ry: 5.0,
                    paint: Paint {
                        fill: Fill::Rgb(215, 219, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
                Node::Rect {
                    x: -36.0,
                    y: -30.0,
                    w: 72.0,
                    h: 11.0,
                    rx: 5.0,
                    ry: 5.0,
                    paint: Paint {
                        fill: Fill::Rgb(79, 209, 138),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
                Node::Path {
                    d: "M-12-19V0M12-19V0M-36-8h72",
                    paint: Paint {
                        fill: Fill::Rgb(0, 0, 0),
                        fill_opacity: 1.0,
                        stroke: Some(Stroke {
                            rgb: (138, 147, 255),
                            width: 2.0,
                            cap: Cap::Butt,
                            join: Join::Miter,
                            dash: &[],
                        }),
                        opacity: 1.0,
                    },
                },
                Node::Rect {
                    x: -28.0,
                    y: 12.0,
                    w: 12.0,
                    h: 14.0,
                    rx: 0.0,
                    ry: 0.0,
                    paint: Paint {
                        fill: Fill::Rgb(111, 124, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
                Node::Rect {
                    x: -10.0,
                    y: 4.0,
                    w: 12.0,
                    h: 22.0,
                    rx: 0.0,
                    ry: 0.0,
                    paint: Paint {
                        fill: Fill::Rgb(79, 209, 138),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
                Node::Rect {
                    x: 8.0,
                    y: 9.0,
                    w: 12.0,
                    h: 17.0,
                    rx: 0.0,
                    ry: 0.0,
                    paint: Paint {
                        fill: Fill::Rgb(139, 123, 255),
                        fill_opacity: 1.0,
                        stroke: None,
                        opacity: 1.0,
                    },
                },
            ],
        }],
    ),
];

pub struct Slots {
    pub amb: &'static [Node],
    pub neck: &'static [Node],
    pub head: &'static [Node],
    pub eyes: &'static [Node],
}

pub static DECOR_SLOTS: &[(&str, Slots)] = &[
    ("default", Slots {
        amb: &[
            Node::Group { transform: "translate(-100 -50) scale(1)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(154, 168, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(102 -40) scale(1)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(154, 168, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
        ],
        head: &[
            Node::Path { d: "M-42-62Q0-108 42-62Z", paint: Paint { fill: Fill::Rgb(43, 47, 212), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (138, 147, 255), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Rect { x: -52.0, y: -66.0, w: 104.0, h: 11.0, rx: 5.5, ry: 5.5, paint: Paint { fill: Fill::Rgb(21, 24, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Group { transform: "translate(0 -82) scale(0.9)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        eyes: &[
        ],
    }),
    ("spring", Slots {
        amb: &[
            Node::Ellipse { cx: -100.0, cy: -60.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Ellipse { cx: 104.0, cy: -70.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 194, 220), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Ellipse { cx: 0.0, cy: -100.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        neck: &[
        ],
        head: &[
            Node::Path { d: "M-62-52Q0-86 62-52", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (91, 209, 138), width: 5.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Group { transform: "translate(-55 -56)", look: false, children: &[Node::Circle { cx: 0.0, cy: -6.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 3.5, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(-28 -68)", look: false, children: &[Node::Circle { cx: 0.0, cy: -6.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 3.5, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(0 -74)", look: false, children: &[Node::Circle { cx: 0.0, cy: -6.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 3.5, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(28 -68)", look: false, children: &[Node::Circle { cx: 0.0, cy: -6.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 3.5, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(55 -56)", look: false, children: &[Node::Circle { cx: 0.0, cy: -6.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 3.5, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        eyes: &[
        ],
    }),
    ("summer", Slots {
        amb: &[
            Node::Group { transform: "translate(108 -70)", look: false, children: &[Node::Circle { cx: 0.0, cy: 0.0, r: 16.0, paint: Paint { fill: Fill::Rgb(255, 208, 74), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Path { d: "M0-26v-8M0 26v8M-26 0h-8M26 0h8M18-18l6-6M-18 18l-6 6M18 18l6 6M-18-18l-6-6", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 208, 74), width: 4.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } }] },
        ],
        neck: &[
        ],
        head: &[
        ],
        eyes: &[
            Node::Rect { x: -52.0, y: -10.0, w: 42.0, h: 26.0, rx: 10.0, ry: 10.0, paint: Paint { fill: Fill::Rgb(11, 11, 34), fill_opacity: 0.62, stroke: Some(Stroke { rgb: (143, 176, 255), width: 2.5, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Rect { x: 10.0, y: -10.0, w: 42.0, h: 26.0, rx: 10.0, ry: 10.0, paint: Paint { fill: Fill::Rgb(11, 11, 34), fill_opacity: 0.62, stroke: Some(Stroke { rgb: (143, 176, 255), width: 2.5, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-10 0h20M-44-2l10-3M18-2l10-3", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (143, 176, 255), width: 3.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
    }),
    ("autumn", Slots {
        amb: &[
            Node::Group { transform: "translate(-100 -80)", look: false, children: &[Node::Path { d: "M0-9Q9-4 0 9Q-9-4 0-9Z", paint: Paint { fill: Fill::Rgb(255, 138, 42), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(0 -110)", look: false, children: &[Node::Path { d: "M0-9Q9-4 0 9Q-9-4 0-9Z", paint: Paint { fill: Fill::Rgb(224, 82, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(105 -60)", look: false, children: &[Node::Path { d: "M0-9Q9-4 0 9Q-9-4 0-9Z", paint: Paint { fill: Fill::Rgb(255, 193, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
            Node::Path { d: "M-62 46Q0 78 62 46L58 64Q0 92-58 64Z", paint: Paint { fill: Fill::Rgb(232, 131, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M30 70l10 30 14-6-8-28Z", paint: Paint { fill: Fill::Rgb(201, 98, 31), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        head: &[
            Node::Group { transform: "translate(52 -68) rotate(30)", look: false, children: &[Node::Path { d: "M0-12Q12-5 0 12Q-12-5 0-12Z", paint: Paint { fill: Fill::Rgb(224, 82, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        eyes: &[
        ],
    }),
    ("halloween", Slots {
        amb: &[
            Node::Group { transform: "translate(-100 54)", look: false, children: &[Node::Ellipse { cx: 0.0, cy: 0.0, rx: 22.0, ry: 18.0, paint: Paint { fill: Fill::Rgb(255, 138, 31), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Ellipse { cx: 0.0, cy: 0.0, rx: 9.0, ry: 18.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 0.6 } }, Node::Rect { x: -2.0, y: -26.0, w: 5.0, h: 9.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::Rgb(74, 138, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Path { d: "M-12-5l5-6 5 6zM2-5l5-6 5 6z", paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Path { d: "M-10 6q10 8 20 0l-4-2-3 3-3-3-3 3-3-3z", paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(98 -92)", look: false, children: &[Node::Path { d: "M-14-4Q-7-10 0 0Q7-10 14-4Q8 0 7 6Q0 2-7 6Q-8 0-14-4Z", paint: Paint { fill: Fill::Rgb(26, 18, 64), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (139, 123, 255), width: 1.5, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } }] },
            Node::Group { transform: "translate(-98 -70)", look: false, children: &[Node::Path { d: "M-14-4Q-7-10 0 0Q7-10 14-4Q8 0 7 6Q0 2-7 6Q-8 0-14-4Z", paint: Paint { fill: Fill::Rgb(26, 18, 64), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (139, 123, 255), width: 1.5, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } }] },
        ],
        neck: &[
        ],
        head: &[
            Node::Ellipse { cx: 0.0, cy: -66.0, rx: 58.0, ry: 11.0, paint: Paint { fill: Fill::Rgb(58, 31, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-32-68L6-136Q10-142 18-132L32-68Z", paint: Paint { fill: Fill::Rgb(90, 47, 176), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: -33.0, y: -82.0, w: 66.0, h: 12.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::Rgb(42, 21, 96), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: -7.0, y: -83.0, w: 14.0, h: 14.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 193, 58), width: 3.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("winter", Slots {
        amb: &[
            Node::Circle { cx: -100.0, cy: -70.0, r: 3.5, paint: Paint { fill: Fill::Rgb(232, 239, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -40.0, cy: -115.0, r: 3.0, paint: Paint { fill: Fill::Rgb(232, 239, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 60.0, cy: -110.0, r: 4.0, paint: Paint { fill: Fill::Rgb(232, 239, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 105.0, cy: -70.0, r: 3.0, paint: Paint { fill: Fill::Rgb(232, 239, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        neck: &[
            Node::Path { d: "M-62 46Q0 78 62 46L58 64Q0 92-58 64Z", paint: Paint { fill: Fill::Rgb(79, 163, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M30 70l10 30 14-6-8-28Z", paint: Paint { fill: Fill::Rgb(43, 111, 212), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        head: &[
            Node::Path { d: "M-40-60Q0-112 40-60Z", paint: Paint { fill: Fill::Rgb(224, 82, 106), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: -44.0, y: -64.0, w: 88.0, h: 12.0, rx: 6.0, ry: 6.0, paint: Paint { fill: Fill::Rgb(242, 244, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 0.0, cy: -102.0, r: 9.0, paint: Paint { fill: Fill::Rgb(242, 244, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("christmas", Slots {
        amb: &[
            Node::Circle { cx: -100.0, cy: -70.0, r: 3.5, paint: Paint { fill: Fill::Rgb(232, 239, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -40.0, cy: -118.0, r: 3.0, paint: Paint { fill: Fill::Rgb(232, 239, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 104.0, cy: -75.0, r: 4.0, paint: Paint { fill: Fill::Rgb(232, 239, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Group { transform: "translate(-104 -30) scale(0.8)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
        ],
        head: &[
            Node::Path { d: "M-40-62Q-30-112 20-116Q52-116 62-90Q44-98 30-84L38-62Z", paint: Paint { fill: Fill::Rgb(224, 50, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: -46.0, y: -68.0, w: 90.0, h: 14.0, rx: 7.0, ry: 7.0, paint: Paint { fill: Fill::Rgb(246, 247, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 62.0, cy: -90.0, r: 9.0, paint: Paint { fill: Fill::Rgb(246, 247, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("newyear", Slots {
        amb: &[
            Node::Rect { x: -100.0, y: -90.0, w: 7.0, h: 4.0, rx: 1.0, ry: 1.0, paint: Paint { fill: Fill::Rgb(255, 107, 129), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: -60.0, y: -110.0, w: 7.0, h: 4.0, rx: 1.0, ry: 1.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: 70.0, y: -105.0, w: 7.0, h: 4.0, rx: 1.0, ry: 1.0, paint: Paint { fill: Fill::Rgb(79, 209, 197), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: 104.0, y: -80.0, w: 7.0, h: 4.0, rx: 1.0, ry: 1.0, paint: Paint { fill: Fill::Rgb(139, 123, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: -110.0, y: -40.0, w: 7.0, h: 4.0, rx: 1.0, ry: 1.0, paint: Paint { fill: Fill::Rgb(79, 209, 197), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: 112.0, y: -30.0, w: 7.0, h: 4.0, rx: 1.0, ry: 1.0, paint: Paint { fill: Fill::Rgb(255, 107, 129), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Group { transform: "translate(-96 -40) scale(0.8)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(100 -55) scale(0.7)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 255, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
        ],
        head: &[
            Node::Path { d: "M-26-66L6-132 38-66Z", paint: Paint { fill: Fill::Rgb(124, 92, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 4.0, cy: -100.0, r: 3.0, paint: Paint { fill: Fill::Rgb(255, 255, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -8.0, cy: -84.0, r: 3.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 16.0, cy: -84.0, r: 3.0, paint: Paint { fill: Fill::Rgb(255, 255, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -2.0, cy: -72.0, r: 3.0, paint: Paint { fill: Fill::Rgb(255, 143, 184), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Group { transform: "translate(6 -134) scale(0.9)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        eyes: &[
        ],
    }),
    ("valentine", Slots {
        amb: &[
            Node::Group { transform: "translate(-96 20) scale(1)", look: false, children: &[Node::Path { d: "M0 7C-16-5-9-16 0-9C9-16 16-5 0 7Z", paint: Paint { fill: Fill::Rgb(255, 143, 184), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(100 10) scale(1.2)", look: false, children: &[Node::Path { d: "M0 7C-16-5-9-16 0-9C9-16 16-5 0 7Z", paint: Paint { fill: Fill::Rgb(255, 92, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(-70 -40) scale(0.8)", look: false, children: &[Node::Path { d: "M0 7C-16-5-9-16 0-9C9-16 16-5 0 7Z", paint: Paint { fill: Fill::Rgb(255, 143, 184), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
        ],
        head: &[
            Node::Group { transform: "translate(44 -68) rotate(15) scale(1.6)", look: false, children: &[Node::Path { d: "M0 7C-16-5-9-16 0-9C9-16 16-5 0 7Z", paint: Paint { fill: Fill::Rgb(255, 92, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        eyes: &[
        ],
    }),
    ("ramadan", Slots {
        amb: &[
            Node::Group { transform: "translate(104 -78)", look: false, children: &[Node::Path { d: "M4-14a14 14 0 1 0 0 28a11 11 0 1 1 0-28Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(78 -100) scale(0.7)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(-100 -70)", look: false, children: &[Node::Path { d: "M0-22V-8", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (183, 191, 255), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } }, Node::Path { d: "M-9-8h18l-3 22h-12Z", paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } }, Node::Rect { x: -6.0, y: 14.0, w: 12.0, h: 4.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
        ],
        head: &[
            Node::Path { d: "M-36-58V-80Q-36-90-26-90H26Q36-90 36-80V-58Z", paint: Paint { fill: Fill::Rgb(20, 18, 46), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (58, 61, 122), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Rect { x: -36.0, y: -70.0, w: 72.0, h: 6.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::Rgb(255, 193, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("eid", Slots {
        amb: &[
            Node::Group { transform: "translate(-100 44)", look: false, children: &[Node::Path { d: "M0-34V-16", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (183, 191, 255), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } }, Node::Group { transform: "rotate(45)", look: false, children: &[Node::Rect { x: -15.0, y: -15.0, w: 30.0, h: 30.0, rx: 3.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(79, 184, 112), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (42, 138, 80), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } }, Node::Path { d: "M-15 0H15M0-15V15M-8-8L8 8M8-8L-8 8", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (42, 138, 80), width: 1.5, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } }] }] },
            Node::Group { transform: "translate(-96 -64) scale(0.8)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(100 -66) scale(1)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(108 -10) scale(0.6)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 255, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
        ],
        head: &[
            Node::Path { d: "M-36-58V-80Q-36-90-26-90H26Q36-90 36-80V-58Z", paint: Paint { fill: Fill::Rgb(20, 18, 46), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (58, 61, 122), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Rect { x: -36.0, y: -70.0, w: 72.0, h: 6.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::Rgb(255, 193, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("independence", Slots {
        amb: &[
            Node::Rect { x: 100.0, y: -112.0, w: 4.0, h: 92.0, rx: 2.0, ry: 2.0, paint: Paint { fill: Fill::Rgb(205, 209, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Group { transform: "translate(104 -110)", look: false, children: &[Node::Rect { x: 0.0, y: 0.0, w: 44.0, h: 14.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::Rgb(232, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Rect { x: 0.0, y: 14.0, w: 44.0, h: 14.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::Rgb(244, 244, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
        ],
        head: &[
            Node::Path { d: "M-84-28Q-50-62 0-62", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (232, 40, 60), width: 12.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M0-62Q50-62 84-28", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (244, 244, 255), width: 12.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("batik", Slots {
        amb: &[
            Node::Group { transform: "translate(-100 -50) scale(0.8)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(232, 181, 99), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(102 -44) scale(0.7)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(232, 181, 99), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
            Node::Path { d: "M-62 44Q0 68 62 44L66 84Q0 100-66 84Z", paint: Paint { fill: Fill::Pattern("dm-batik"), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-24 46L0 76 24 46Z", paint: Paint { fill: Fill::Rgb(244, 226, 184), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-62 44Q0 68 62 44", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (232, 181, 99), width: 3.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
        head: &[
            Node::Path { d: "M-38-58Q-38-86 0-88Q38-86 38-58Q38-50 0-52Q-38-50-38-58Z", paint: Paint { fill: Fill::Pattern("dm-batik"), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (59, 35, 20), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-38-60Q0-54 38-60", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (59, 35, 20), width: 4.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("kimono", Slots {
        amb: &[
            Node::Ellipse { cx: -100.0, cy: -60.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 194, 220), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Ellipse { cx: 104.0, cy: -70.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 183, 209), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Ellipse { cx: 0.0, cy: -104.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 194, 220), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        neck: &[
            Node::Path { d: "M-62 44Q0 68 62 44L66 84Q0 100-66 84Z", paint: Paint { fill: Fill::Rgb(217, 74, 106), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-26 46L2 84M26 46L-2 84", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (246, 247, 255), width: 7.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Rect { x: -66.0, y: 68.0, w: 132.0, h: 14.0, rx: 3.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (232, 169, 58), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Rect { x: 34.0, y: 62.0, w: 22.0, h: 24.0, rx: 4.0, ry: 4.0, paint: Paint { fill: Fill::Rgb(232, 169, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -44.0, cy: 58.0, r: 2.4, paint: Paint { fill: Fill::Rgb(255, 209, 224), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -30.0, cy: 62.0, r: 2.4, paint: Paint { fill: Fill::Rgb(255, 209, 224), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 40.0, cy: 54.0, r: 2.4, paint: Paint { fill: Fill::Rgb(255, 209, 224), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -52.0, cy: 74.0, r: 2.4, paint: Paint { fill: Fill::Rgb(255, 209, 224), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        head: &[
            Node::Group { transform: "translate(58 -62)", look: false, children: &[Node::Circle { cx: 0.0, cy: -6.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 183, 209), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 183, 209), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 183, 209), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 183, 209), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 183, 209), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 3.5, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Path { d: "M50-52L36-40", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 3.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("hanbok", Slots {
        amb: &[
            Node::Ellipse { cx: -100.0, cy: -60.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Ellipse { cx: 104.0, cy: -70.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 194, 220), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        neck: &[
            Node::Path { d: "M-64 62Q0 78 64 62L78 88Q0 106-78 88Z", paint: Paint { fill: Fill::Rgb(255, 143, 184), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Ellipse { cx: -76.0, cy: 60.0, rx: 14.0, ry: 20.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (244, 193, 74), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Ellipse { cx: 76.0, cy: 60.0, rx: 14.0, ry: 20.0, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (244, 193, 74), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-60 44Q0 66 60 44L58 66Q0 80-58 66Z", paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (244, 193, 74), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-18 46L0 66 18 46", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 255, 255), width: 5.0, cap: Cap::Round, join: Join::Round, dash: &[] }), opacity: 1.0 } },
            Node::Group { transform: "rotate(-20 -9 62)", look: false, children: &[Node::Ellipse { cx: -9.0, cy: 62.0, rx: 9.0, ry: 5.0, paint: Paint { fill: Fill::Rgb(232, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "rotate(20 9 62)", look: false, children: &[Node::Ellipse { cx: 9.0, cy: 62.0, rx: 9.0, ry: 5.0, paint: Paint { fill: Fill::Rgb(232, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Path { d: "M0 64l-6 22M0 64l6 22", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (232, 40, 60), width: 4.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
        head: &[
            Node::Group { transform: "translate(56 -58) rotate(18)", look: false, children: &[Node::Ellipse { cx: -8.0, cy: 0.0, rx: 9.0, ry: 5.5, paint: Paint { fill: Fill::Rgb(232, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Ellipse { cx: 8.0, cy: 0.0, rx: 9.0, ry: 5.5, paint: Paint { fill: Fill::Rgb(232, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 4.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Path { d: "M0 4l-5 18M0 4l5 18", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (232, 40, 60), width: 3.5, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } }] },
        ],
        eyes: &[
        ],
    }),
    ("changshan", Slots {
        amb: &[
            Node::Group { transform: "translate(-100 -66)", look: false, children: &[Node::Path { d: "M0-22V-8", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (183, 191, 255), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } }, Node::Path { d: "M-9-8h18l-3 22h-12Z", paint: Paint { fill: Fill::Rgb(232, 40, 60), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } }, Node::Rect { x: -6.0, y: 14.0, w: 12.0, h: 4.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(102 -48) scale(0.8)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
            Node::Path { d: "M-62 44Q0 68 62 44L66 84Q0 100-66 84Z", paint: Paint { fill: Fill::Rgb(201, 32, 47), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-62 44Q0 68 62 44", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 3.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-24 42Q0 54 24 42L22 56Q0 66-22 56Z", paint: Paint { fill: Fill::Rgb(168, 22, 31), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-20 56L30 80", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 3.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Circle { cx: -10.0, cy: 62.0, r: 3.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 6.0, cy: 70.0, r: 3.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 20.0, cy: 77.0, r: 3.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        head: &[
            Node::Path { d: "M-34-58Q-34-84 0-84Q34-84 34-58Q0-52-34-58Z", paint: Paint { fill: Fill::Rgb(20, 18, 46), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Circle { cx: 0.0, cy: -86.0, r: 5.0, paint: Paint { fill: Fill::Rgb(217, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("kurta", Slots {
        amb: &[
            Node::Ellipse { cx: -100.0, cy: -60.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Ellipse { cx: 104.0, cy: -70.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 193, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Ellipse { cx: 0.0, cy: -104.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        neck: &[
            Node::Path { d: "M-62 44Q0 68 62 44L66 84Q0 100-66 84Z", paint: Paint { fill: Fill::Rgb(31, 168, 154), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-22 44Q0 56 22 44", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 4.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M0 54V84", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 3.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Circle { cx: 0.0, cy: 62.0, r: 2.6, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 0.0, cy: 72.0, r: 2.6, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 0.0, cy: 82.0, r: 2.6, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-56 48L30 82", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 157, 63), width: 10.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 0.92 } },
            Node::Path { d: "M-56 48L30 82", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 2.0, cap: Cap::Round, join: Join::Miter, dash: &[3.0, 5.0] }), opacity: 1.0 } },
        ],
        head: &[
            Node::Group { transform: "translate(52 -62)", look: false, children: &[Node::Circle { cx: 0.0, cy: -6.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 3.5, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(66 -48)", look: false, children: &[Node::Circle { cx: 0.0, cy: -6.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 193, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 193, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 193, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 193, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 193, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 3.5, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        eyes: &[
        ],
    }),
    ("thobe", Slots {
        amb: &[
            Node::Group { transform: "translate(-100 -50) scale(0.8)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(102 -44) scale(0.7)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
            Node::Path { d: "M-62 44Q0 68 62 44L66 84Q0 100-66 84Z", paint: Paint { fill: Fill::Rgb(242, 244, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M0 48V82", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (199, 204, 240), width: 3.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-20 44Q0 58 20 44", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (199, 204, 240), width: 4.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Circle { cx: 0.0, cy: 62.0, r: 2.2, paint: Paint { fill: Fill::Rgb(199, 204, 240), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 0.0, cy: 72.0, r: 2.2, paint: Paint { fill: Fill::Rgb(199, 204, 240), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        head: &[
            Node::Path { d: "M-86-14Q-84-84 0-88Q84-84 86-14L72 0Q64-44 0-52Q-64-44-72 0Z", paint: Paint { fill: Fill::Pattern("dm-kef"), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (199, 204, 240), width: 1.5, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Ellipse { cx: 0.0, cy: -70.0, rx: 46.0, ry: 9.0, paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (20, 18, 46), width: 6.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("jas", Slots {
        amb: &[
        ],
        neck: &[
            Node::Path { d: "M-62 44Q0 68 62 44L66 84Q0 100-66 84Z", paint: Paint { fill: Fill::Rgb(58, 63, 92), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-16 48L0 82 16 48Z", paint: Paint { fill: Fill::Rgb(246, 247, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-16 48L-34 64M16 48L34 64", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (42, 46, 72), width: 4.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-4 56L4 56 6 78 0 84-6 78Z", paint: Paint { fill: Fill::Rgb(217, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        head: &[
            Node::Ellipse { cx: 0.0, cy: -64.0, rx: 54.0, ry: 9.0, paint: Paint { fill: Fill::Rgb(13, 13, 34), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-36-62Q-36-98 0-98Q36-98 36-62Z", paint: Paint { fill: Fill::Rgb(20, 18, 46), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Rect { x: -36.0, y: -74.0, w: 72.0, h: 8.0, rx: 0.0, ry: 0.0, paint: Paint { fill: Fill::Rgb(90, 95, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("beret", Slots {
        amb: &[
            Node::Group { transform: "translate(-100 -50) scale(0.7)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
            Node::Group { transform: "translate(102 -44) scale(0.7)", look: false, children: &[Node::Path { d: "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z", paint: Paint { fill: Fill::Rgb(255, 255, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        neck: &[
            Node::Path { d: "M-62 46Q0 78 62 46L58 64Q0 92-58 64Z", paint: Paint { fill: Fill::Rgb(58, 91, 217), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M30 70l10 30 14-6-8-28Z", paint: Paint { fill: Fill::Rgb(42, 69, 176), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-40 56l6 14M-14 62l4 14M14 62l-4 14M40 56l-6 14", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 255, 255), width: 3.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
        head: &[
            Node::Group { transform: "rotate(-8)", look: false, children: &[Node::Path { d: "M-44-62Q-42-94 6-94Q46-92 50-66Q50-60 0-58Q-44-58-44-62Z", paint: Paint { fill: Fill::Rgb(217, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Rect { x: 2.0, y: -101.0, w: 6.0, h: 9.0, rx: 2.0, ry: 2.0, paint: Paint { fill: Fill::Rgb(154, 22, 35), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        eyes: &[
        ],
    }),
    ("sombrero", Slots {
        amb: &[
            Node::Text { x: -104.0, y: -40.0, size: 22.0, bold: true, middle: false, rgb: (255, 214, 107), opacity: 1.0, text: "♪" },
            Node::Text { x: 104.0, y: -60.0, size: 22.0, bold: true, middle: false, rgb: (255, 214, 107), opacity: 1.0, text: "♫" },
        ],
        neck: &[
            Node::Path { d: "M-66 44Q0 68 66 44L78 90Q0 112-78 90Z", paint: Paint { fill: Fill::Rgb(224, 82, 58), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-72 66Q0 90 72 66", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 214, 107), width: 6.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-75 80Q0 104 75 80", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (79, 209, 197), width: 6.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
        ],
        head: &[
            Node::Ellipse { cx: 0.0, cy: -60.0, rx: 80.0, ry: 15.0, paint: Paint { fill: Fill::Rgb(232, 178, 74), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (184, 134, 42), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-28-62Q-26-104 0-106Q26-104 28-62Z", paint: Paint { fill: Fill::Rgb(232, 178, 74), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (184, 134, 42), width: 2.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Path { d: "M-28-70Q0-64 28-70", paint: Paint { fill: Fill::None, fill_opacity: 1.0, stroke: Some(Stroke { rgb: (217, 40, 60), width: 8.0, cap: Cap::Butt, join: Join::Miter, dash: &[] }), opacity: 1.0 } },
            Node::Circle { cx: -58.0, cy: -58.0, r: 2.4, paint: Paint { fill: Fill::Rgb(217, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -36.0, cy: -50.0, r: 2.4, paint: Paint { fill: Fill::Rgb(217, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 36.0, cy: -50.0, r: 2.4, paint: Paint { fill: Fill::Rgb(217, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 58.0, cy: -58.0, r: 2.4, paint: Paint { fill: Fill::Rgb(217, 40, 60), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        eyes: &[
        ],
    }),
    ("aloha", Slots {
        amb: &[
            Node::Group { transform: "translate(108 -70)", look: false, children: &[Node::Circle { cx: 0.0, cy: 0.0, r: 16.0, paint: Paint { fill: Fill::Rgb(255, 208, 74), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Path { d: "M0-26v-8M0 26v8M-26 0h-8M26 0h8M18-18l6-6M-18 18l-6 6M18 18l6 6M-18-18l-6-6", paint: Paint { fill: Fill::Rgb(0, 0, 0), fill_opacity: 1.0, stroke: Some(Stroke { rgb: (255, 208, 74), width: 4.0, cap: Cap::Round, join: Join::Miter, dash: &[] }), opacity: 1.0 } }] },
            Node::Ellipse { cx: -100.0, cy: -60.0, rx: 6.0, ry: 3.0, paint: Paint { fill: Fill::Rgb(255, 158, 199), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        neck: &[
            Node::Path { d: "M-62 44Q0 68 62 44L66 84Q0 100-66 84Z", paint: Paint { fill: Fill::Pattern("dm-aloha"), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Path { d: "M-24 46L0 72 24 46Z", paint: Paint { fill: Fill::Rgb(29, 143, 155), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -50.0, cy: 49.4, r: 6.0, paint: Paint { fill: Fill::Rgb(255, 92, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -34.0, cy: 60.5, r: 6.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: -17.0, cy: 67.6, r: 6.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 0.0, cy: 70.0, r: 6.0, paint: Paint { fill: Fill::Rgb(255, 255, 255), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 17.0, cy: 67.6, r: 6.0, paint: Paint { fill: Fill::Rgb(255, 92, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 34.0, cy: 60.5, r: 6.0, paint: Paint { fill: Fill::Rgb(255, 214, 107), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
            Node::Circle { cx: 50.0, cy: 49.4, r: 6.0, paint: Paint { fill: Fill::Rgb(255, 157, 63), fill_opacity: 1.0, stroke: None, opacity: 1.0 } },
        ],
        head: &[
            Node::Group { transform: "translate(58 -58) scale(1.4)", look: false, children: &[Node::Circle { cx: 0.0, cy: -6.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 92, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 92, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 92, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -4.0, cy: 5.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 92, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: -6.0, cy: -2.0, r: 5.0, paint: Paint { fill: Fill::Rgb(255, 92, 138), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }, Node::Circle { cx: 0.0, cy: 0.0, r: 3.5, paint: Paint { fill: Fill::Rgb(255, 226, 122), fill_opacity: 1.0, stroke: None, opacity: 1.0 } }] },
        ],
        eyes: &[
        ],
    }),
];

pub struct Stop {
    pub offset: f64,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub opacity: f64,
}

pub enum GradKind {
    Linear { x1: f64, y1: f64, x2: f64, y2: f64 },
    Radial,
}

pub struct GradDef {
    pub id: &'static str,
    pub kind: GradKind,
    pub stops: &'static [Stop],
}

pub static GRADIENTS: &[GradDef] = &[
    GradDef {
        id: "dm-hood",
        kind: GradKind::Linear {
            x1: 0.0,
            y1: 0.0,
            x2: 0.0,
            y2: 1.0,
        },
        stops: &[
            Stop {
                offset: 0.0,
                r: 111,
                g: 139,
                b: 255,
                opacity: 1.0,
            },
            Stop {
                offset: 1.0,
                r: 43,
                g: 47,
                b: 212,
                opacity: 1.0,
            },
        ],
    },
    GradDef {
        id: "dm-face",
        kind: GradKind::Linear {
            x1: 0.0,
            y1: 0.0,
            x2: 0.0,
            y2: 1.0,
        },
        stops: &[
            Stop {
                offset: 0.0,
                r: 21,
                g: 19,
                b: 61,
                opacity: 1.0,
            },
            Stop {
                offset: 1.0,
                r: 10,
                g: 10,
                b: 40,
                opacity: 1.0,
            },
        ],
    },
    GradDef {
        id: "dm-eye",
        kind: GradKind::Linear {
            x1: 0.0,
            y1: 0.0,
            x2: 0.0,
            y2: 1.0,
        },
        stops: &[
            Stop {
                offset: 0.0,
                r: 154,
                g: 240,
                b: 255,
                opacity: 1.0,
            },
            Stop {
                offset: 1.0,
                r: 63,
                g: 162,
                b: 255,
                opacity: 1.0,
            },
        ],
    },
    GradDef {
        id: "dm-paw",
        kind: GradKind::Linear {
            x1: 0.0,
            y1: 0.0,
            x2: 0.0,
            y2: 1.0,
        },
        stops: &[
            Stop {
                offset: 0.0,
                r: 164,
                g: 176,
                b: 255,
                opacity: 1.0,
            },
            Stop {
                offset: 1.0,
                r: 106,
                g: 92,
                b: 255,
                opacity: 1.0,
            },
        ],
    },
    GradDef {
        id: "dm-shd",
        kind: GradKind::Linear {
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        },
        stops: &[
            Stop {
                offset: 0.0,
                r: 154,
                g: 139,
                b: 255,
                opacity: 1.0,
            },
            Stop {
                offset: 1.0,
                r: 90,
                g: 70,
                b: 216,
                opacity: 1.0,
            },
        ],
    },
    GradDef {
        id: "dm-sh",
        kind: GradKind::Radial,
        stops: &[
            Stop {
                offset: 0.0,
                r: 58,
                g: 63,
                b: 224,
                opacity: 0.42,
            },
            Stop {
                offset: 1.0,
                r: 58,
                g: 63,
                b: 224,
                opacity: 0.0,
            },
        ],
    },
];

pub struct PatternDef {
    pub id: &'static str,
    pub w: f64,
    pub h: f64,
    pub nodes: &'static [Node],
}

pub static PATTERNS: &[PatternDef] = &[
    PatternDef {
        id: "dm-batik",
        w: 14.0,
        h: 14.0,
        nodes: &[
            Node::Rect {
                x: 0.0,
                y: 0.0,
                w: 14.0,
                h: 14.0,
                rx: 0.0,
                ry: 0.0,
                paint: Paint {
                    fill: Fill::Rgb(122, 74, 46),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 7.0,
                cy: 7.0,
                r: 3.4,
                paint: Paint {
                    fill: Fill::None,
                    fill_opacity: 1.0,
                    stroke: Some(Stroke {
                        rgb: (232, 181, 99),
                        width: 1.3,
                        cap: Cap::Butt,
                        join: Join::Miter,
                        dash: &[],
                    }),
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 0.0,
                cy: 0.0,
                r: 1.8,
                paint: Paint {
                    fill: Fill::Rgb(232, 181, 99),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 14.0,
                cy: 0.0,
                r: 1.8,
                paint: Paint {
                    fill: Fill::Rgb(232, 181, 99),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 0.0,
                cy: 14.0,
                r: 1.8,
                paint: Paint {
                    fill: Fill::Rgb(232, 181, 99),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 14.0,
                cy: 14.0,
                r: 1.8,
                paint: Paint {
                    fill: Fill::Rgb(232, 181, 99),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
        ],
    },
    PatternDef {
        id: "dm-kef",
        w: 10.0,
        h: 10.0,
        nodes: &[
            Node::Rect {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
                rx: 0.0,
                ry: 0.0,
                paint: Paint {
                    fill: Fill::Rgb(242, 244, 255),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Rect {
                x: 0.0,
                y: 0.0,
                w: 5.0,
                h: 5.0,
                rx: 0.0,
                ry: 0.0,
                paint: Paint {
                    fill: Fill::Rgb(217, 40, 60),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.78,
                },
            },
            Node::Rect {
                x: 5.0,
                y: 5.0,
                w: 5.0,
                h: 5.0,
                rx: 0.0,
                ry: 0.0,
                paint: Paint {
                    fill: Fill::Rgb(217, 40, 60),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 0.78,
                },
            },
        ],
    },
    PatternDef {
        id: "dm-aloha",
        w: 24.0,
        h: 24.0,
        nodes: &[
            Node::Rect {
                x: 0.0,
                y: 0.0,
                w: 24.0,
                h: 24.0,
                rx: 0.0,
                ry: 0.0,
                paint: Paint {
                    fill: Fill::Rgb(43, 179, 192),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 7.0,
                cy: 7.0,
                r: 4.2,
                paint: Paint {
                    fill: Fill::Rgb(255, 122, 168),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 7.0,
                cy: 7.0,
                r: 1.6,
                paint: Paint {
                    fill: Fill::Rgb(255, 226, 122),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Path {
                d: "M17 15q4-5 6 0q-3 4-6 0Z",
                paint: Paint {
                    fill: Fill::Rgb(31, 143, 106),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
            Node::Circle {
                cx: 19.0,
                cy: 4.0,
                r: 2.0,
                paint: Paint {
                    fill: Fill::Rgb(255, 226, 122),
                    fill_opacity: 1.0,
                    stroke: None,
                    opacity: 1.0,
                },
            },
        ],
    },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pose_for_mapping() {
        assert_eq!(pose_for("waiting_approval", ""), "permission");
        assert_eq!(pose_for("working", "coding"), "coding");
        assert_eq!(pose_for("working", "unknown"), "working");
        assert_eq!(pose_for("working", "dokumen"), "document");
        assert_eq!(pose_for("coding", "slide"), "coding");
        assert_eq!(pose_for("idle", ""), "idle");
        assert_eq!(pose_for("bogus-status", ""), "idle");
    }

    #[test]
    fn auto_decor_returns_valid_key() {
        let d = auto_decor();
        assert!(
            DECORS.iter().any(|(k, _)| *k == d),
            "auto_decor returned unknown key: {d}"
        );
    }

    #[test]
    fn decors_and_costumes_catalogue() {
        assert_eq!(DECORS.len(), 12);
        assert_eq!(COSTUMES.len(), 10);
        assert_eq!(DECORS[0], ("default", "Kapten"));
        assert_eq!(COSTUMES[0], ("batik", "Batik · Indonesia"));
    }

    #[test]
    fn path_parser_handles_arc_and_smooth_cubic() {
        let surf = cairo::ImageSurface::create(cairo::Format::ARgb32, 120, 120).unwrap();
        let cr = cairo::Context::new(&surf).unwrap();
        // Relative arc (a) + smooth cubic (S) + smooth quad (T): must not panic.
        cr.new_path();
        draw_path(&cr, "M10 10 a20 20 0 1 0 30 30 S60 60 80 40 T100 10 Z");
        // Absolute arc (A), cubic (C), smooth cubic (S), quad (Q).
        cr.new_path();
        draw_path(&cr, "M10 90 C20 80 30 80 40 90 S70 100 80 90 Q90 80 95 90");
        cr.new_path();
        draw_path(&cr, "M5 5 A10 10 0 0 1 25 25 L40 40 H50 V60 Z");
        // Degenerate arcs must not panic either.
        cr.new_path();
        draw_path(&cr, "M10 10 A0 0 0 0 0 10 10 M20 20 A10 10 0 0 0 20 20");
    }

    #[test]
    fn draw_mascot_runs_on_image_surface() {
        for pose in ["idle", "working", "error"] {
            let surf = cairo::ImageSurface::create(cairo::Format::ARgb32, 200, 200).unwrap();
            let cr = cairo::Context::new(&surf).unwrap();
            draw_mascot(&cr, pose, "default", "none", 200.0, (0.0, 0.0));
        }
        // Auto decor + a pattern costume (batik) + off-center pupils.
        let surf = cairo::ImageSurface::create(cairo::Format::ARgb32, 200, 200).unwrap();
        let cr = cairo::Context::new(&surf).unwrap();
        draw_mascot(&cr, "idle", "auto", "batik", 200.0, (0.5, -0.5));
        // Out-of-range pupils are clamped, not fatal.
        draw_mascot(&cr, "thinking", "winter", "none", 200.0, (3.0, -3.0));
        // Degenerate sizes are no-ops, not panics.
        draw_mascot(&cr, "idle", "default", "none", 0.0, (0.0, 0.0));
        draw_mascot(&cr, "idle", "default", "none", -10.0, (0.0, 0.0));
    }
}

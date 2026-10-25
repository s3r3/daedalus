// dae-island — Fase 1 skeleton: island layer-shell native Rust (tanpa webview).
//
// Cakupan Fase 1 (lihat DESIGN.md di ~/workspace/your_files/dae-captain-native-island/):
// - window layer-shell (Top, anchor atas, exclusive zone 0, keyboard on-demand)
// - pil statis + animasi expand/collapse manual (ease-out cubic, ~250ms)
// - panel skeleton (chat entry + pill engine + footer) — data live & aksi
//   menyusul di Fase 2/3, jadi belum ada koneksi ke server :3080 di sini.
//
// Build: cargo build (butuh libgtk-4-dev + libgtk4-layer-shell-dev).
// Jalankan: cargo run — hanya di Wayland/Hyprland (VM tidak punya display).

use gtk4::prelude::*;
use gtk4::{
    Application, ApplicationWindow, Box as GtkBox, Button, CssProvider, Entry, Label,
    Orientation,
};
use gtk4_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

const APP_ID: &str = "cc.ayid.dae-island";
const ANIM_MS: u128 = 250;

// Ukuran window (request) per state. Lebar panel mengikuti desain §3.
const COLLAPSED_W: i32 = 280;
const COLLAPSED_H: i32 = 52;
const EXPANDED_W: i32 = 480;
const EXPANDED_H: i32 = 380;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Collapsed,
    Expanded,
}

struct Anim {
    start: Instant,
    from_w: i32,
    from_h: i32,
    to_w: i32,
    to_h: i32,
    /// Sembunyikan panel saat animasi collapse selesai.
    hide_panel_on_done: bool,
}

struct Island {
    mode: Mode,
    anim: Option<Anim>,
}

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

fn build_ui(app: &Application) {
    // ---------- CSS ----------
    let css = CssProvider::new();
    css.load_from_data(
        "
        window { background-color: transparent; }
        .island-root { background-color: transparent; }
        .island-pill {
            background-color: rgba(18, 18, 26, 0.92);
            border-radius: 26px;
            padding: 10px 16px;
            color: #ffffff;
        }
        .island-panel {
            background-color: rgba(18, 18, 26, 0.94);
            border-radius: 20px;
            padding: 14px;
            color: #ffffff;
        }
        .engine-pill {
            background-color: rgba(255, 255, 255, 0.12);
            border-radius: 999px;
            padding: 4px 10px;
            color: #ffffff;
        }
        .footer-note { color: rgba(255, 255, 255, 0.55); font-size: 11px; }
        ",
    );
    gtk4::style_context_add_provider_for_display(
        &gtk4::gdk::Display::default().expect("display"),
        &css,
        gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    // ---------- Window + layer-shell ----------
    let window = ApplicationWindow::builder()
        .application(app)
        .title("Dae Island")
        .decorated(false)
        .build();
    window.init_layer_shell();
    window.set_layer(Layer::Top);
    window.set_anchor(Edge::Top, true);
    window.set_margin(Edge::Top, 8);
    // Exclusive zone 0: island melayang di atas konten, tidak mendorong window lain.
    window.set_exclusive_zone(0);
    window.set_keyboard_mode(KeyboardMode::OnDemand);
    window.set_namespace(Some("dae-captain-island"));

    // ---------- Layout ----------
    let root = GtkBox::new(Orientation::Vertical, 8);
    root.add_css_class("island-root");
    root.set_size_request(COLLAPSED_W, COLLAPSED_H);

    // Pil (selalu terlihat): tombol agar klik di mana saja pada pil me-expand.
    let pill_btn = Button::new();
    pill_btn.add_css_class("island-pill");
    let pill_row = GtkBox::new(Orientation::Horizontal, 8);
    let dot = Label::new(Some("●"));
    let title = Label::new(Some("Dae Captain"));
    let status = Label::new(Some("server: belum terhubung"));
    status.add_css_class("footer-note");
    pill_row.append(&dot);
    pill_row.append(&title);
    pill_row.append(&status);
    pill_btn.set_child(Some(&pill_row));

    // Panel (baru terlihat saat expanded).
    let panel = GtkBox::new(Orientation::Vertical, 10);
    panel.add_css_class("island-panel");
    panel.set_visible(false);
    let chat = Entry::new();
    chat.set_placeholder_text(Some("Tanya Dae Captain… (Fase 3)"));
    let engines = GtkBox::new(Orientation::Horizontal, 6);
    for name in ["Coding", "Slide", "Dokumen", "Spreadsheet", "Research"] {
        let pill = Label::new(Some(name));
        pill.add_css_class("engine-pill");
        engines.append(&pill);
    }
    let footer = Label::new(Some("Fase 1 — data live & aksi menyusul di Fase 2/3"));
    footer.add_css_class("footer-note");
    panel.append(&chat);
    panel.append(&engines);
    panel.append(&footer);

    root.append(&pill_btn);
    root.append(&panel);
    window.set_child(Some(&root));

    // ---------- State + animasi ----------
    let state = Rc::new(RefCell::new(Island {
        mode: Mode::Collapsed,
        anim: None,
    }));

    let state_tick = state.clone();
    let root_tick = root.clone();
    let panel_tick = panel.clone();
    window.add_tick_callback(move |_win, _clock| {
        let mut st = state_tick.borrow_mut();
        let Some(anim) = &st.anim else {
            return gtk4::glib::ControlFlow::Break;
        };
        let elapsed = anim.start.elapsed().as_millis() as f64 / ANIM_MS as f64;
        let t = elapsed.min(1.0);
        let e = ease_out_cubic(t);
        let w = anim.from_w + ((anim.to_w - anim.from_w) as f64 * e) as i32;
        let h = anim.from_h + ((anim.to_h - anim.from_h) as f64 * e) as i32;
        root_tick.set_size_request(w, h);
        if t >= 1.0 {
            if anim.hide_panel_on_done {
                panel_tick.set_visible(false);
            }
            st.anim = None;
            gtk4::glib::ControlFlow::Break
        } else {
            gtk4::glib::ControlFlow::Continue
        }
    });

    let state_click = state.clone();
    let panel_click = panel.clone();
    let chat_click = chat.clone();
    pill_btn.connect_clicked(move |_| {
        let mut st = state_click.borrow_mut();
        match st.mode {
            Mode::Collapsed => {
                panel_click.set_visible(true);
                st.anim = Some(Anim {
                    start: Instant::now(),
                    from_w: COLLAPSED_W,
                    from_h: COLLAPSED_H,
                    to_w: EXPANDED_W,
                    to_h: EXPANDED_H,
                    hide_panel_on_done: false,
                });
                st.mode = Mode::Expanded;
                chat_click.grab_focus();
            }
            Mode::Expanded => {
                st.anim = Some(Anim {
                    start: Instant::now(),
                    from_w: EXPANDED_W,
                    from_h: EXPANDED_H,
                    to_w: COLLAPSED_W,
                    to_h: COLLAPSED_H,
                    hide_panel_on_done: true,
                });
                st.mode = Mode::Collapsed;
            }
        }
        // Tick callback menginterpolasi dari ukuran `from_*` mulai frame
        // berikutnya; satu frame di ukuran lama tidak terlihat sebagai lompatan.
    });

    window.present();
}

fn main() {
    let app = Application::builder().application_id(APP_ID).build();
    app.connect_activate(build_ui);
    app.run();
}

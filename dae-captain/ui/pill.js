// Dae Captain UI — PillController (Fase 6).
//
// Owns the dynamic-island pill: 9 statuses, SVG progress ring, real action
// buttons, smart click, notification pulse, do-not-disturb, and the done
// flash. Pure DOM; all decisions come from derivePillState() (logic.js),
// all side effects go out through the onAction callback so every control
// is wired to a real operation in app.js — no decorative buttons.
//
//   new PillController({ root, onAction })
//   onAction(action, payload): "cancel" {taskId} | "pause" {taskId} |
//     "resume" {taskId} | "view" {status} | "click" {status}

import { derivePillState, acknowledgePillErrors, PILL_STATUSES } from "./logic.js";

const DND_KEY = "dae-captain:pill-dnd";
const NOTIFY_KEY = "dae-captain:pill-notify";
const DONE_FLASH_MS = 4200;

/** Statuses that deserve an audible ping when notify mode is "sound". */
const ALERT_STATUSES = new Set(["waiting_approval", "done", "error"]);

const RING_C = 2 * Math.PI * 15.5;

export class PillController {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root - the #pill element
   * @param {(action: string, payload: object) => void} opts.onAction
   */
  constructor({ root, onAction }) {
    if (!root) throw new Error("PillController needs a root element");
    this.root = root;
    this.onAction = onAction ?? (() => {});
    this.memory = {}; // turn ledger for derivePillState (done flash, error ack)
    this.dnd = false;
    /** Notification mode: "pulse" (default), "sound", or "off" — Settings → Pill. */
    this.notifyMode = "pulse";
    this.manual = null; // setStatus() override; cleared by update()
    this.lastRuns = [];
    this.doneTimer = null;
    this.lastNotifiedStatus = null;
    try {
      this.dnd = localStorage.getItem(DND_KEY) === "1";
      const nm = localStorage.getItem(NOTIFY_KEY);
      if (nm === "pulse" || nm === "sound" || nm === "off") this.notifyMode = nm;
    } catch {
      /* storage unavailable — defaults */
    }
    this.dot = root.querySelector(".pill-dot");
    this.text = root.querySelector("#pill-text");
    this.actions = root.querySelector(".pill-actions");
    this.ringFill = root.querySelector(".ring-fill");
    this._wire();
    this._render({ status: "idle", label: "Dae Captain", dot: "green", buttons: [], pulse: false, progress: null });
  }

  _wire() {
    // Button clicks must not trigger the pill's smart click.
    this.root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn) {
        e.stopPropagation();
        this._fire(btn.dataset.act);
        return;
      }
      this._fire("click");
    });
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._fire("click");
      }
    });
  }

  _fire(kind) {
    const s = this.state ?? { status: "idle" };
    if (kind === "click" && s.status === "paused" && s.resumeTaskId) {
      this.onAction("resume", { taskId: s.resumeTaskId, status: s.status });
      return;
    }
    if (kind === "click" && s.status === "error") {
      acknowledgePillErrors(this.lastRuns, this.memory);
    }
    const payload = { status: s.status, taskId: s.cancelTaskId ?? s.pauseTaskId ?? s.resumeTaskId ?? s.primary?.taskId ?? null };
    if (kind === "cancel" && s.cancelTaskId) payload.taskId = s.cancelTaskId;
    if (kind === "pause" && s.pauseTaskId) payload.taskId = s.pauseTaskId;
    if (kind === "resume" && s.resumeTaskId) payload.taskId = s.resumeTaskId;
    this.onAction(kind, payload);
  }

  /** Manual override: `setStatus("working", "Menyiapkan…")`. Cleared by the next update(). */
  setStatus(status, detail) {
    if (!PILL_STATUSES.includes(status)) throw new Error(`unknown pill status: ${status}`);
    this.manual = {
      status,
      label: typeof detail === "string" && detail ? detail : status,
      dot: status === "error" ? "red" : status === "idle" ? "green" : "blue",
      buttons: [],
      pulse: false,
      progress: null,
      tasks: [],
      primary: null,
      cancelTaskId: null,
      pauseTaskId: null,
      resumeTaskId: null,
      approvalCount: 0,
    };
    this._render(this.manual);
  }

  /** Derive the 9-state view-model from workflow runs and render it. */
  update(runs) {
    this.lastRuns = runs ?? [];
    this.manual = null;
    const state = derivePillState(this.lastRuns, this.memory, { dnd: this.dnd });
    this._render(state);
    // Mascot v2 observes pill data-status/data-engine via MutationObserver —
    // no manual setMascotStatus needed here.
    // Sound mode: one ping per transition into an alert status (never in
    // do-not-disturb).
    if (
      this.notifyMode === "sound" &&
      !this.dnd &&
      ALERT_STATUSES.has(state.status) &&
      state.status !== this.lastNotifiedStatus
    ) {
      this._beep();
    }
    if (ALERT_STATUSES.has(state.status)) this.lastNotifiedStatus = state.status;
    else if (state.status === "idle" || state.status === "working") this.lastNotifiedStatus = null;
    // The done flash is transient: re-derive after it expires so the pill
    // falls back to idle (or whatever is actually current).
    clearTimeout(this.doneTimer);
    if (state.status === "done") {
      this.doneTimer = setTimeout(() => {
        this.doneTimer = null;
        this.update(this.lastRuns);
      }, DONE_FLASH_MS);
    }
  }

  show() {
    this.root.classList.remove("hidden");
  }

  hide() {
    this.root.classList.add("hidden");
  }

  /** Do-not-disturb: approvals stay queued, the pill stays quiet (no pulse, no auto-expand — app.js checks this too). */
  setDoNotDisturb(on) {
    this.dnd = on === true;
    try {
      localStorage.setItem(DND_KEY, this.dnd ? "1" : "0");
    } catch {
      /* ignore */
    }
    // Re-render under the new mode immediately.
    if (!this.manual) this.update(this.lastRuns);
  }

  isDoNotDisturb() {
    return this.dnd;
  }

  /**
   * A1: Reminder fired — pulse the pill (unless DND) to get attention.
   * The chat message carries the details; this is just the visual nudge.
   */
  notifyReminder() {
    if (this.dnd) return;
    this.manual = {
      status: "idle",
      label: "⏰ Pengingat",
      dot: "blue",
      buttons: [],
      pulse: true,
      progress: null,
      tasks: [],
      primary: null,
      cancelTaskId: null,
      pauseTaskId: null,
      resumeTaskId: null,
      approvalCount: 0,
    };
    this._render(this.manual);
    // Clear the pulse after 30s so it doesn't throb forever.
    clearTimeout(this._reminderTimer);
    this._reminderTimer = setTimeout(() => {
      this._reminderTimer = null;
      this.manual = null;
      this.update(this.lastRuns);
    }, 30_000);
  }

  /**
   * Notification mode (Settings → Pill → Notifikasi), persisted in
   * localStorage and mirrored to the Rust prefs by app.js:
   * - "pulse": the pill throbs on alerts (default, no sound);
   * - "sound": one soft ping per alert-status transition, no throb;
   * - "off": quiet entirely (DND-equivalent silence for alerts).
   */
  setNotificationMode(mode) {
    if (mode !== "pulse" && mode !== "sound" && mode !== "off") {
      throw new Error(`unknown notify mode: ${mode}`);
    }
    this.notifyMode = mode;
    try {
      localStorage.setItem(NOTIFY_KEY, mode);
    } catch {
      /* ignore */
    }
    if (!this.manual) this.update(this.lastRuns);
  }

  getNotificationMode() {
    return this.notifyMode;
  }

  /** Soft two-tone ping via WebAudio — no audio files, no dependencies. */
  _beep() {
    try {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AC) return;
      this._ac = this._ac ?? new AC();
      const ac = this._ac;
      if (ac.state === "suspended") void ac.resume().catch(() => {});
      const t0 = ac.currentTime;
      for (const [dt, freq] of [[0, 880], [0.12, 660]]) {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + dt);
        gain.gain.exponentialRampToValueAtTime(0.12, t0 + dt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.18);
        osc.connect(gain).connect(ac.destination);
        osc.start(t0 + dt);
        osc.stop(t0 + dt + 0.2);
      }
    } catch {
      /* audio unavailable — stay silent, never break the pill */
    }
  }

  _render(s) {
    this.state = s;
    this.root.classList.remove("hidden");
    this.root.dataset.status = s.status;
    this.root.dataset.engine = s.primary?.engine ?? "";
    // Pulse only in "pulse" notify mode; "sound" and "off" stay still.
    this.root.classList.toggle("pill-pulse", s.pulse === true && this.notifyMode === "pulse");
    this.root.classList.toggle("pill-dnd", this.dnd);
    if (this.dot) this.dot.className = "pill-dot " + (s.dot || "blue");
    if (this.text) this.text.textContent = s.label || "";
    this.root.setAttribute("aria-label", `Dae Captain — ${s.label || s.status}. Klik untuk membuka.`);

    // Progress ring: determinate fraction, indeterminate spin while busy,
    // hidden track otherwise.
    if (this.ringFill) {
      const ring = this.ringFill;
      const busy = ["working", "verifying", "fixing"].includes(s.status);
      ring.classList.toggle("ring-spin", busy && !s.progress);
      if (s.progress && s.progress.total > 0) {
        const frac = Math.min(1, Math.max(0, s.progress.current / s.progress.total));
        ring.style.strokeDasharray = `${(frac * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`;
        ring.style.strokeDashoffset = "0";
      } else {
        ring.style.strokeDasharray = `${(RING_C * 0.28).toFixed(1)} ${RING_C.toFixed(1)}`;
        ring.style.strokeDashoffset = "0";
      }
      ring.style.opacity = busy ? "1" : "0";
    }

    // Action buttons — every one is wired to a real operation in app.js.
    if (this.actions) {
      const btns = s.buttons ?? [];
      const mk = (act, glyph, title, label) =>
        `<button class="pill-btn${label ? " pill-btn-text" : ""}" data-act="${act}" title="${title}" aria-label="${title}">${label ?? glyph}</button>`;
      let html = "";
      if (btns.includes("pause")) html += mk("pause", "⏸", "Jeda task");
      if (btns.includes("cancel")) html += mk("cancel", "✕", "Batalkan task");
      if (btns.includes("view")) html += mk("view", "", "Lihat di chat", "Lihat");
      this.actions.innerHTML = html;
    }
  }
}

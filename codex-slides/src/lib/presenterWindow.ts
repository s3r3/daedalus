import type { SlideTransition } from "./types";

export interface PresenterWindowSlide {
  index: number;
  url: string;
  title: string;
  speakerNotes?: string;
  transition?: SlideTransition;
}

export interface PresenterWindowLabels {
  windowTitle: string;
  notesTitle: string;
  pause: string;
  resume: string;
  reset: string;
  previous: string;
  next: string;
  empty: string;
  slide: string;
  save: string;
  saving: string;
  saved: string;
  saveFailed: string;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the self-contained presenter popup. It deliberately owns no project
 * state: navigation and note edits round-trip through the audience window. */
export function buildPresenterWindowHtml(options: {
  title: string;
  channelId: string;
  projectId: string;
  slides: readonly PresenterWindowSlide[];
  initialIndex: number;
  labels: PresenterWindowLabels;
}): string {
  const data = {
    channelId: options.channelId,
    projectId: options.projectId,
    slides: options.slides,
    initialIndex: Math.max(0, Math.min(options.slides.length - 1, options.initialIndex)),
    labels: options.labels,
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.title)} — ${escapeHtml(options.labels.windowTitle)}</title>
  <style>
    * { box-sizing: border-box; }
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    html, body { width: 100%; height: 100%; min-width: 720px; min-height: 620px; margin: 0; overflow: hidden; background: #111318; color: #f5f6f8; }
    body { display: grid; grid-template-columns: minmax(0, 1.42fr) minmax(330px, .86fr); }
    button, textarea { font: inherit; }
    button { min-height: 38px; padding: 0 13px; border: 1px solid rgba(255,255,255,.12); border-radius: 9px; color: #eceef3; background: #23262e; cursor: pointer; }
    button:hover:not(:disabled) { background: #2c303a; border-color: rgba(255,255,255,.2); }
    button:disabled { opacity: .38; cursor: default; }
    .stage { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) 166px; gap: 14px; padding: 18px; border-right: 1px solid #2b2e36; }
    .topbar { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .timer { margin-right: 4px; font-size: 30px; line-height: 1; font-weight: 780; font-variant-numeric: tabular-nums; letter-spacing: -.04em; }
    .counter { margin-left: auto; color: #afb4c0; font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .current { position: relative; min-height: 0; display: grid; place-items: center; overflow: hidden; border: 1px solid #30343e; border-radius: 11px; background: #050608; cursor: pointer; }
    .current:hover { border-color: #4b5160; }
    img { display: block; width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
    .filmstrip { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; min-height: 0; }
    .filmstrip section { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0,1fr); cursor: pointer; }
    .filmstrip section[hidden] { display: none; }
    #previous-section { grid-column: 1; }
    #next-section { grid-column: 2; }
    .thumb-label { margin-bottom: 6px; color: #8f95a2; font-size: 11px; font-weight: 720; letter-spacing: .07em; text-transform: uppercase; }
    .thumb-frame { min-height: 0; overflow: hidden; border: 1px solid #30343e; border-radius: 8px; background: #08090c; }
    .filmstrip section:hover .thumb-frame { border-color: #4b5160; }
    .notes { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); background: #181a20; }
    .notes-head { min-height: 66px; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 22px; border-bottom: 1px solid #2b2e36; }
    .notes-title { color: #e3e5ea; font-size: 16px; font-weight: 760; }
    .slide-label { margin-top: 3px; color: #8f95a2; font-size: 12px; }
    .save-status { min-width: 52px; color: #7fc99a; font-size: 12px; font-weight: 650; text-align: right; }
    .save-status.error { color: #ff8d8d; }
    .notes-body { min-height: 0; padding: 26px; overflow: auto; cursor: text; }
    .note-text { min-height: 100%; white-space: pre-wrap; color: #f0f1f4; font-size: clamp(18px, 1.65vw, 23px); line-height: 1.6; font-weight: 550; }
    .note-text.empty { color: #777d89; font-style: italic; }
    textarea { width: 100%; height: calc(100% - 54px); min-height: 220px; resize: none; padding: 14px; border: 1px solid #3a3e49; border-radius: 10px; outline: none; color: #f4f5f7; background: #101116; font-size: 18px; line-height: 1.58; }
    textarea:focus { border-color: #7d86ff; box-shadow: 0 0 0 3px rgba(125,134,255,.15); }
    .notes-actions { display: flex; justify-content: flex-end; padding-top: 12px; }
    @media (max-width: 980px) {
      body { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1.4fr) minmax(220px, .7fr); overflow: auto; }
      .stage { border-right: 0; border-bottom: 1px solid #2b2e36; grid-template-rows: auto minmax(260px, 1fr) 110px; }
      .notes { min-height: 240px; }
      .notes-body { padding: 20px 22px; }
    }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
  </style>
</head>
<body>
  <main class="stage">
    <div class="topbar">
      <div class="timer" id="timer">0:00</div>
      <button type="button" id="pause"></button>
      <button type="button" id="reset"></button>
      <div class="counter" id="counter"></div>
    </div>
    <div class="current" id="current-stage"><img id="current" alt="" /></div>
    <div class="filmstrip">
      <section id="previous-section"><div class="thumb-label" id="previous-label"></div><div class="thumb-frame"><img id="previous" alt="" /></div></section>
      <section id="next-section"><div class="thumb-label" id="next-label"></div><div class="thumb-frame"><img id="next" alt="" /></div></section>
    </div>
  </main>
  <aside class="notes">
    <div class="notes-head">
      <div><div class="notes-title" id="notes-title"></div><div class="slide-label" id="slide-label"></div></div>
      <div class="save-status" id="save-status" aria-live="polite"></div>
    </div>
    <div class="notes-body" id="notes-body"></div>
  </aside>
  <script type="application/json" id="presenter-data">${safeJson(data)}</script>
  <script>
    (function(){
      var data = JSON.parse(document.getElementById('presenter-data').textContent || '{}');
      var slides = Array.isArray(data.slides) ? data.slides.slice() : [];
      var labels = data.labels || {};
      var index = Math.max(0, Math.min(slides.length - 1, Number(data.initialIndex) || 0));
      var paused = false;
      var startedAt = Date.now();
      var pausedMs = 0;
      var timerId = 0;
      var editing = false;
      var flushNoteEdit = null;
      var els = {
        timer: document.getElementById('timer'), pause: document.getElementById('pause'), reset: document.getElementById('reset'),
        counter: document.getElementById('counter'), current: document.getElementById('current'), previous: document.getElementById('previous'),
        next: document.getElementById('next'), previousSection: document.getElementById('previous-section'), nextSection: document.getElementById('next-section'),
        previousLabel: document.getElementById('previous-label'), nextLabel: document.getElementById('next-label'), notesTitle: document.getElementById('notes-title'),
        slideLabel: document.getElementById('slide-label'), notesBody: document.getElementById('notes-body'), saveStatus: document.getElementById('save-status')
      };
      function send(type, payload){
        try {
          if (window.opener && !window.opener.closed) window.opener.postMessage(Object.assign({ type: type, channelId: data.channelId, projectId: data.projectId }, payload || {}), '*');
        } catch (_) {}
      }
      function fmt(ms){ var seconds = Math.max(0, Math.floor(ms / 1000)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
      function tick(){ els.timer.textContent = fmt(paused ? pausedMs : pausedMs + Date.now() - startedAt); }
      function slideAt(target){ return slides[target] || null; }
      function setImage(element, slide){
        if (!slide) { element.removeAttribute('src'); element.alt = ''; return; }
        if (element.getAttribute('src') !== slide.url) element.src = slide.url;
        element.alt = slide.title || '';
      }
      function showStatus(text, error){
        els.saveStatus.textContent = text || '';
        els.saveStatus.className = 'save-status' + (error ? ' error' : '');
        if (text) window.setTimeout(function(){ if (els.saveStatus.textContent === text) els.saveStatus.textContent = ''; }, 2600);
      }
      function renderNotes(){
        var slide = slideAt(index) || {};
        var note = String(slide.speakerNotes || '');
        els.slideLabel.textContent = String(labels.slide || 'Slide {current} / {total}').replace('{current}', String(index + 1)).replace('{total}', String(slides.length));
        els.notesBody.textContent = '';
        if (editing) {
          var textarea = document.createElement('textarea');
          textarea.value = note;
          textarea.placeholder = labels.empty || '';
          var actions = document.createElement('div');
          actions.className = 'notes-actions';
          var save = document.createElement('button');
          save.type = 'button';
          save.textContent = labels.save || 'Save';
          var saveTimer = 0;
          var lastSent = note;
          function saveNote(closeEditor){
            window.clearTimeout(saveTimer);
            var value = textarea.value;
            if (value !== lastSent) {
              lastSent = value;
              slide.speakerNotes = value;
              showStatus(labels.saving || 'Saving…', false);
              send('codex-slides:presenter-notes-save', { index: slide.index, note: value });
            }
            if (closeEditor) { editing = false; flushNoteEdit = null; renderNotes(); }
          }
          flushNoteEdit = function(){ saveNote(false); };
          save.onclick = function(){ saveNote(true); };
          textarea.addEventListener('input', function(){
            window.clearTimeout(saveTimer);
            saveTimer = window.setTimeout(function(){ saveNote(false); }, 700);
          });
          textarea.addEventListener('blur', function(){ saveNote(false); });
          textarea.addEventListener('keydown', function(event){
            if (event.key === 'Escape') { event.preventDefault(); editing = false; renderNotes(); }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveNote(true); }
          });
          actions.appendChild(save);
          els.notesBody.appendChild(textarea);
          els.notesBody.appendChild(actions);
          textarea.focus();
        } else {
          flushNoteEdit = null;
          var text = document.createElement('div');
          text.className = note.trim() ? 'note-text' : 'note-text empty';
          text.tabIndex = 0;
          text.setAttribute('role', 'textbox');
          text.setAttribute('aria-readonly', 'true');
          text.textContent = note.trim() ? note : (labels.empty || '');
          text.onclick = function(){ editing = true; renderNotes(); };
          text.onkeydown = function(event){ if (event.key === 'Enter') { event.preventDefault(); editing = true; renderNotes(); } };
          els.notesBody.appendChild(text);
        }
      }
      function render(){
        if (!slides.length) return;
        els.counter.textContent = (index + 1) + ' / ' + slides.length;
        setImage(els.current, slideAt(index));
        var previous = slideAt(index - 1); var next = slideAt(index + 1);
        els.previousSection.hidden = !previous; els.nextSection.hidden = !next;
        setImage(els.previous, previous); setImage(els.next, next);
        renderNotes();
      }
      function go(next, fromHost){
        var target = Math.max(0, Math.min(slides.length - 1, next));
        if (target === index) { if (fromHost && !editing) renderNotes(); return; }
        if (flushNoteEdit) flushNoteEdit();
        index = target; editing = false; render();
        if (!fromHost) send('codex-slides:presenter-go', { position: index });
      }
      function close(){ if (flushNoteEdit) flushNoteEdit(); send('codex-slides:presenter-close', {}); try { window.close(); } catch (_) {} }
      els.pause.textContent = labels.pause || 'Pause'; els.reset.textContent = labels.reset || 'Reset';
      els.previousLabel.textContent = labels.previous || 'Previous'; els.nextLabel.textContent = labels.next || 'Next'; els.notesTitle.textContent = labels.notesTitle || 'Speaker notes';
      els.pause.onclick = function(){
        if (paused) { paused = false; startedAt = Date.now(); els.pause.textContent = labels.pause || 'Pause'; }
        else { paused = true; pausedMs += Date.now() - startedAt; els.pause.textContent = labels.resume || 'Resume'; }
        tick();
      };
      els.reset.onclick = function(){ startedAt = Date.now(); pausedMs = 0; tick(); go(0); };
      document.getElementById('current-stage').onclick = function(){ go(index + 1); };
      els.previousSection.onclick = function(){ go(index - 1); }; els.nextSection.onclick = function(){ go(index + 1); };
      window.addEventListener('keydown', function(event){
        if (event.target && /^(TEXTAREA|INPUT)$/.test(event.target.tagName)) return;
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') { event.preventDefault(); go(index + 1); }
        else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); go(index - 1); }
        else if (event.key === 'Home') { event.preventDefault(); go(0); }
        else if (event.key === 'End') { event.preventDefault(); go(slides.length - 1); }
      });
      window.addEventListener('message', function(event){
        var message = event.data || {};
        if (message.channelId !== data.channelId || message.projectId !== data.projectId) return;
        if (message.type === 'codex-slides:presenter-state') {
          if (Array.isArray(message.slides)) slides = message.slides.slice();
          if (typeof message.position === 'number') go(message.position, true); else render();
        } else if (message.type === 'codex-slides:presenter-notes-status') {
          showStatus(message.ok ? (labels.saved || 'Saved') : (labels.saveFailed || 'Save failed'), !message.ok);
        }
      });
      timerId = window.setInterval(tick, 250);
      window.addEventListener('beforeunload', function(){ window.clearInterval(timerId); });
      tick(); render();
    })();
  </script>
</body>
</html>`;
}

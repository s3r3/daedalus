"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";
import { buildPresenterWindowHtml } from "@/lib/presenterWindow";
import type { SlideTransition } from "@/lib/types";

export interface PlayModeSlide {
  index: number;
  url: string;
  title: string;
  transition?: SlideTransition;
  speakerNotes?: string;
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d={direction === "left" ? "m12.5 4.5-5 5.5 5 5.5" : "m7.5 4.5 5 5.5-5 5.5"} />
    </svg>
  );
}

function FullscreenIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {active ? (
        <path d="M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5" />
      ) : (
        <path d="M8 3H3v5M12 3h5v5M8 17H3v-5M12 17h5v-5" />
      )}
    </svg>
  );
}

/** Audience slideshow. Its controls are a true overlay and only appear when
 * the pointer enters the fixed bottom reveal zone, so the slide never resizes. */
export default function PlayMode({
  slides,
  initialIndex = 0,
  projectId,
  deckTitle,
  presenterWindow,
  onSpeakerNotesChange,
  onSlideChange,
  onClose,
}: {
  slides: PlayModeSlide[];
  initialIndex?: number;
  projectId: string;
  deckTitle: string;
  presenterWindow?: Window | null;
  onSpeakerNotesChange?: (index: number, note: string) => Promise<unknown>;
  onSlideChange?: (slide: PlayModeSlide) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [i, setI] = useState(() => Math.max(0, Math.min(slides.length - 1, initialIndex)));
  const [controlsVisible, setControlsVisible] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const presenterInitialized = useRef(false);
  const channelId = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `present-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const showControls = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setControlsVisible(true);
  }, []);

  const scheduleHideControls = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 420);
  }, []);

  const move = useCallback(
    (delta: number) => setI((current) => Math.max(0, Math.min(slides.length - 1, current + delta))),
    [slides.length],
  );

  // The presenter window is owned by the parent (it opened it with a user
  // gesture and tears it down in onClose). PlayMode never closes it directly:
  // doing so from an effect cleanup lets React StrictMode's dev-only
  // mount→unmount→mount cycle destroy the window it just opened.
  const close = useCallback(async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    onClose();
  }, [onClose]);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    else await rootRef.current?.requestFullscreen().catch(() => undefined);
  }, []);

  const presenterSlides = useMemo(() => slides.map((slide) => ({
    ...slide,
    url: typeof window === "undefined" ? slide.url : new URL(slide.url, window.location.href).toString(),
  })), [slides]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void close();
      } else if (["ArrowRight", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        move(1);
      } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Home") {
        event.preventDefault();
        setI(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setI(Math.max(0, slides.length - 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, move, slides.length]);

  useEffect(() => {
    if (!slides.length) return;
    const position = Math.max(0, Math.min(slides.length - 1, i));
    onSlideChange?.(slides[position]);
  }, [i, onSlideChange, slides]);

  useEffect(() => {
    if (!presenterWindow || presenterWindow.closed || presenterInitialized.current) return;
    presenterInitialized.current = true;
    const html = buildPresenterWindowHtml({
      title: deckTitle,
      channelId: channelId.current,
      projectId,
      slides: presenterSlides,
      initialIndex: i,
      labels: {
        windowTitle: t("presenter.windowTitle"),
        notesTitle: t("speakerNotes.title"),
        pause: t("presenter.pause"),
        resume: t("presenter.resume"),
        reset: t("presenter.reset"),
        previous: t("presenter.previous"),
        next: t("presenter.next"),
        empty: t("speakerNotes.emptyPresenter"),
        slide: t("presenter.slide", { current: "{current}", total: "{total}" }),
        save: t("speakerNotes.save"),
        saving: t("speakerNotes.saving"),
        saved: t("speakerNotes.saved"),
        saveFailed: t("speakerNotes.failed"),
      },
    });
    presenterWindow.document.open();
    presenterWindow.document.write(html);
    presenterWindow.document.close();
    presenterWindow.focus();
  }, [deckTitle, i, presenterSlides, presenterWindow, projectId, t]);

  useEffect(() => {
    if (!presenterWindow || presenterWindow.closed) return;
    presenterWindow.postMessage({
      type: "codex-slides:presenter-state",
      channelId: channelId.current,
      projectId,
      position: i,
      slides: presenterSlides,
    }, "*");
  }, [i, presenterSlides, presenterWindow, projectId]);

  useEffect(() => {
    if (!presenterWindow) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== presenterWindow) return;
      const message = event.data as {
        type?: string;
        channelId?: string;
        projectId?: string;
        position?: number;
        index?: number;
        note?: string;
      } | null;
      if (!message || message.channelId !== channelId.current || message.projectId !== projectId) return;
      if (message.type === "codex-slides:presenter-go" && typeof message.position === "number") {
        setI(Math.max(0, Math.min(slides.length - 1, Math.floor(message.position))));
      } else if (message.type === "codex-slides:presenter-close") {
        void close();
      } else if (
        message.type === "codex-slides:presenter-notes-save"
        && typeof message.index === "number"
        && typeof message.note === "string"
      ) {
        Promise.resolve(onSpeakerNotesChange?.(message.index, message.note))
          .then(() => presenterWindow.postMessage({
            type: "codex-slides:presenter-notes-status",
            channelId: channelId.current,
            projectId,
            ok: true,
          }, "*"))
          .catch(() => presenterWindow.postMessage({
            type: "codex-slides:presenter-notes-status",
            channelId: channelId.current,
            projectId,
            ok: false,
          }, "*"));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [close, onSpeakerNotesChange, presenterWindow, projectId, slides.length]);

  if (!slides.length) return null;
  const currentIndex = Math.max(0, Math.min(i, slides.length - 1));
  const slide = slides[currentIndex];
  const progress = ((currentIndex + 1) / slides.length) * 100;

  return (
    <div
      ref={rootRef}
      className={`playmode${controlsVisible ? " controls-visible" : " controls-hidden"}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("play.mode")}
    >
      <div className="playmode-stage">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={`${slide.index}-${currentIndex}`}
          className={`playmode-slide playmode-transition-${slide.transition ?? "none"}`}
          src={slide.url}
          alt={slide.title}
        />
      </div>

      <button
        type="button"
        className="playmode-page-hit playmode-page-hit-prev"
        onClick={() => move(-1)}
        disabled={currentIndex === 0}
        aria-label={t("slide.previous")}
      />
      <button
        type="button"
        className="playmode-page-hit playmode-page-hit-next"
        onClick={() => move(1)}
        disabled={currentIndex === slides.length - 1}
        aria-label={t("slide.next")}
      />

      <div
        className="playmode-control-trigger"
        onMouseEnter={showControls}
        onMouseLeave={scheduleHideControls}
        onTouchStart={showControls}
      >
        <div className="playmode-dock playmode-chrome">
          <button onClick={() => move(-1)} disabled={currentIndex === 0} aria-label={t("slide.previous")}>
            <Chevron direction="left" />
          </button>
          <div className="playmode-meta" aria-live="polite">
            <div className="playmode-meta-line">
              <strong>{currentIndex + 1} / {slides.length}</strong>
              <span>{slide.title}</span>
            </div>
            <div className="playmode-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>
          </div>
          <button onClick={() => move(1)} disabled={currentIndex === slides.length - 1} aria-label={t("slide.next")}>
            <Chevron direction="right" />
          </button>
          <span className="playmode-dock-sep" aria-hidden="true" />
          <button onClick={toggleFullscreen} aria-label={fullscreen ? t("play.exitFullscreen") : t("play.enterFullscreen")}>
            <FullscreenIcon active={fullscreen} />
          </button>
          <button className="playmode-dock-exit" onClick={() => void close()} aria-label={t("play.exitPresentation")}>
            <span>{t("play.exit")}</span><kbd>Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

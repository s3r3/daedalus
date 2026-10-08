"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  FilmStrip,
  Image,
  PencilSimple,
  Play as PlayIcon,
  Plus,
  Sparkle,
  Trash,
} from "@phosphor-icons/react";
import ExportMenu from "@/components/ExportMenu";
import MarkCanvas from "@/components/MarkCanvas";
import PlayMode from "@/components/PlayMode";
import SpeakerNotesPanel from "@/components/SpeakerNotesPanel";
import TransitionPicker from "@/components/TransitionPicker";
import {
  addProjectSlide,
  deleteProjectSlide,
  duplicateProjectSlide,
  fileUrl,
  generateProjectSpeakerNotes,
  markSlide,
  moveProjectSlide,
  saveMarkSource,
  saveProjectSpeakerNote,
  setProjectSlideTransition,
  uploadProjectSlide,
  type UiSlide,
} from "@/lib/deckEdit";
import type { SlideTransition } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

export type MarkAgentEvent =
  | { type: "request"; slide: UiSlide; note: string; markedImage: string }
  | { type: "complete"; slide: UiSlide; note: string; image: string }
  | { type: "error"; slide: UiSlide; note: string; error: string };

/** A slide-shaped shimmer placeholder used while a page is queued or drawing. */
function SlideSkeleton({ caption }: { caption?: string }) {
  return (
    <div className="skel-slide">
      <div className="skel-row">
        <span className="skeleton skel-badge" />
        <span className="skeleton skel-line w30" />
      </div>
      <span className="skeleton skel-line w70 tall" />
      <span className="skeleton skel-line w45" />
      <div className="skel-cols">
        <span className="skeleton skel-block" />
        <div className="skel-lines">
          <span className="skeleton skel-line w90" />
          <span className="skeleton skel-line w80" />
          <span className="skeleton skel-line w85" />
          <span className="skeleton skel-line w60" />
        </div>
      </div>
      {caption && (
        <div className="skel-caption">
          <span className="spinner sm" /> {caption}
        </div>
      )}
    </div>
  );
}

async function normalizeSlideImage(
  file: File,
  aspect: string,
  errors: { tooLarge: string; prepare: string; convert: string },
): Promise<Blob> {
  if (file.size > 20 * 1024 * 1024) throw new Error(errors.tooLarge);
  const bitmap = await createImageBitmap(file);
  const [rawW, rawH] = aspect.split(":").map(Number);
  const ratio = rawW > 0 && rawH > 0 ? rawW / rawH : 16 / 9;
  const width = ratio >= 1 ? 1920 : Math.round(1920 * ratio);
  const height = ratio >= 1 ? Math.round(1920 / ratio) : 1920;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(errors.prepare);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  context.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(errors.convert))), "image/png");
  });
}

/** Per-page editor with page creation, upload, AI generation, navigation and export. */
export default function SlideStage({
  projectId,
  aspect,
  title,
  slides,
  onSlides,
  busy,
  setBusy,
  streaming = false,
  showTitle = true,
  headerPrefix,
  headerExtra,
  onAskSlide,
  onMarkAgentEvent,
  onStartMarkRun,
  focusSlideIndex,
  focusSlideKey = 0,
  deepLinkAction,
}: {
  projectId: string | null;
  aspect: string;
  title: string;
  slides: UiSlide[];
  onSlides: (updater: (s: UiSlide[]) => UiSlide[]) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  streaming?: boolean;
  /** The shared workspace header can own the project title instead. */
  showTitle?: boolean;
  headerPrefix?: React.ReactNode;
  headerExtra?: React.ReactNode;
  /** Attach a page to the deck-agent conversation for a scoped follow-up. */
  onAskSlide?: (slide: UiSlide) => void;
  /** Mirror visual-mark editing into the persistent deck conversation. */
  onMarkAgentEvent?: (event: MarkAgentEvent) => void;
  /** Project workspaces can detach the long-running mark edit from this view. */
  onStartMarkRun?: (input: {
    slide: UiSlide;
    note: string;
    source: string;
  }) => Promise<void>;
  /** External navigation request originating from a chat attachment. */
  focusSlideIndex?: number | null;
  /** Increment to repeat navigation to the same externally requested slide. */
  focusSlideKey?: number;
  /** One-shot Browser handoff action encoded in the project URL. */
  deepLinkAction?: {
    key: number;
    slideIndex?: number;
    panel?: "speaker-notes" | "export" | "play";
    mode?: "workspace" | "play" | "presenter";
  };
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<number | null>(null);
  const [markTarget, setMarkTarget] = useState<number | null>(null);
  const [transitionTarget, setTransitionTarget] = useState<number | null>(null);
  const [transitionSaving, setTransitionSaving] = useState(false);
  const [playSession, setPlaySession] = useState<{
    initialIndex: number;
    presenterWindow: Window | null;
  } | null>(null);
  const [playOpen, setPlayOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [actionError, setActionError] = useState("");
  const [structureBusy, setStructureBusy] = useState(false);
  const [addingAfter, setAddingAfter] = useState<number | null>(null);
  const [enteringSlide, setEnteringSlide] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<number | null>(null);
  const userPicked = useRef(false);
  const stageRef = useRef<HTMLElement>(null);
  const handledDeepLinkKey = useRef(0);
  // The stage owns the presenter popup's lifetime. Keeping the handle here (not
  // inside PlayMode) means React StrictMode remounting the overlay can't tear
  // down the window, and it is always closed exactly once when playback ends.
  const presenterWindowRef = useRef<Window | null>(null);

  const arCss = useMemo(() => aspect.replace(":", " / "), [aspect]);
  const current = slides.find((slide) => slide.index === selected) ?? slides[0];
  const currentPosition = current ? slides.findIndex((slide) => slide.index === current.index) : -1;
  const rendered = slides.filter((slide) => slide.status === "rendered").length;
  const canEdit = Boolean(projectId) && !busy && !streaming && !structureBusy;
  const canExport = Boolean(rendered) && Boolean(projectId);

  useEffect(() => {
    if (userPicked.current) return;
    const last = [...slides].reverse().find((slide) => slide.image) ?? slides.find((slide) => slide.status === "working");
    if (last) setSelected(last.index);
    else if (slides.length && selected == null) setSelected(slides[0].index);
  }, [slides, selected]);

  useEffect(() => {
    if (!playOpen) return;
    const close = (event: MouseEvent) => {
      if (playRef.current && !playRef.current.contains(event.target as Node)) setPlayOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [playOpen]);

  useEffect(() => {
    if (selected == null) return;
    const frame = stripRef.current?.querySelector<HTMLElement>(`[data-slide-index="${selected}"]`);
    frame?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [selected]);

  useEffect(() => {
    if (enteringSlide == null) return;
    const timer = window.setTimeout(() => setEnteringSlide(null), 520);
    return () => window.clearTimeout(timer);
  }, [enteringSlide]);

  useEffect(() => {
    if (focusSlideIndex == null || !slides.some((slide) => slide.index === focusSlideIndex)) return;
    pick(focusSlideIndex);
    requestAnimationFrame(() => stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    // focusSlideKey intentionally allows repeated requests for the same slide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSlideIndex, focusSlideKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (playSession || markTarget != null || transitionTarget != null) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft" && currentPosition > 0) {
        event.preventDefault();
        pick(slides[currentPosition - 1].index);
      }
      if (event.key === "ArrowRight" && currentPosition >= 0 && currentPosition < slides.length - 1) {
        event.preventDefault();
        pick(slides[currentPosition + 1].index);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // pick intentionally closes per-page UI alongside navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPosition, markTarget, playSession, slides, transitionTarget]);

  function replaceSlides(next: UiSlide[]) {
    onSlides(() => next);
  }

  function update(index: number, patch: Partial<UiSlide>) {
    onSlides((items) => items.map((slide) => (slide.index === index ? { ...slide, ...patch } : slide)));
  }

  /**
   * Keep already-loaded image URLs stable across page-list mutations. Pages
   * whose filenames really changed are decoded before React swaps the list, so
   * inserting a blank page does not make the deck and thumbnails flash white.
   */
  async function prepareStructuralSlides(
    next: UiSlide[],
    previousFor: (slide: UiSlide) => UiSlide | undefined,
  ) {
    const prepared = next.map((slide) => {
      const previous = previousFor(slide);
      return previous && previous.image === slide.image ? { ...slide, bust: previous.bust } : slide;
    });

    await Promise.all(
      prepared.map((slide) => {
        const previous = previousFor(slide);
        const nextUrl = fileUrl(projectId!, slide.image, slide.bust);
        const previousUrl = fileUrl(projectId!, previous?.image, previous?.bust);
        if (!nextUrl || nextUrl === previousUrl) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const image = new window.Image();
          const done = () => resolve();
          image.onload = done;
          image.onerror = done;
          image.src = nextUrl;
          if (image.complete) done();
        });
      }),
    );

    return prepared;
  }

  function pick(index: number) {
    userPicked.current = true;
    setSelected(index);
    setMarkTarget(null);
    setActionError("");
  }

  function movePage(delta: number) {
    const next = slides[currentPosition + delta];
    if (next) pick(next.index);
  }

  async function addBlankSlide(afterIndex = slides.length) {
    if (!projectId || busy || streaming || structureBusy) return;
    const insertAfter = Math.max(0, Math.min(slides.length, afterIndex));
    setStructureBusy(true);
    setAddingAfter(insertAfter);
    setActionError("");
    try {
      const next = await addProjectSlide(projectId, afterIndex);
      const prepared = await prepareStructuralSlides(next, (slide) => {
        if (slide.index <= insertAfter) return slides.find((item) => item.index === slide.index);
        if (slide.index > insertAfter + 1) return slides.find((item) => item.index === slide.index - 1);
        return undefined;
      });
      replaceSlides(prepared);
      const added = prepared[insertAfter];
      if (added) {
        pick(added.index);
        setEnteringSlide(added.index);
      }
    } catch (error: any) {
      setActionError(String(error?.message ?? error));
    } finally {
      setAddingAfter(null);
      setStructureBusy(false);
    }
  }

  async function duplicatePage(index: number) {
    if (!projectId || busy || structureBusy) return;
    setStructureBusy(true);
    try {
      const next = await duplicateProjectSlide(projectId, index);
      const prepared = await prepareStructuralSlides(next, (slide) => {
        if (slide.index <= index) return slides.find((item) => item.index === slide.index);
        if (slide.index > index + 1) return slides.find((item) => item.index === slide.index - 1);
        return undefined;
      });
      replaceSlides(prepared);
      const added = prepared[index];
      if (added) pick(added.index);
    } catch (error: any) {
      setActionError(String(error?.message ?? error));
    } finally {
      setStructureBusy(false);
    }
  }

  async function deletePage(index: number) {
    if (!projectId || busy || structureBusy) return;
    setStructureBusy(true);
    try {
      const next = await deleteProjectSlide(projectId, index);
      const prepared = await prepareStructuralSlides(next, (slide) => {
        const previousIndex = slide.index < index ? slide.index : slide.index + 1;
        return slides.find((item) => item.index === previousIndex);
      });
      replaceSlides(prepared);
      const fallback = prepared[Math.min(index - 1, prepared.length - 1)];
      if (fallback) pick(fallback.index);
      else setSelected(null);
    } catch (error: any) {
      setActionError(String(error?.message ?? error));
    } finally {
      setStructureBusy(false);
    }
  }

  async function reorderPage(index: number, delta: -1 | 1) {
    if (!projectId || busy || structureBusy) return;
    const toIndex = index + delta;
    if (toIndex < 1 || toIndex > slides.length) return;
    setStructureBusy(true);
    setActionError("");
    try {
      const before = [...slides];
      const reordered = [...before];
      const [moved] = reordered.splice(index - 1, 1);
      reordered.splice(toIndex - 1, 0, moved);
      const next = await moveProjectSlide(projectId, index, toIndex);
      const prepared = await prepareStructuralSlides(next, (slide) => reordered[slide.index - 1]);
      replaceSlides(prepared);
      pick(toIndex);
    } catch (error: any) {
      setActionError(String(error?.message ?? error));
    } finally {
      setStructureBusy(false);
    }
  }

  function askAgent(index: number) {
    const slide = slides.find((item) => item.index === index);
    if (!slide) return;
    pick(index);
    if (onAskSlide) onAskSlide(slide);
    else setActionError(t("slide.agentUnavailable"));
  }

  function chooseUpload(index: number) {
    uploadTarget.current = index;
    uploadRef.current?.click();
  }

  async function handleUpload(file?: File) {
    const index = uploadTarget.current;
    if (!file || index == null || !projectId || busy) return;
    const before = slides.find((slide) => slide.index === index);
    setBusy(true);
    setActionError("");
    update(index, { status: "working" });
    try {
      const png = await normalizeSlideImage(file, aspect, {
        tooLarge: t("slide.imageTooLarge"),
        prepare: t("slide.imagePrepareFailed"),
        convert: t("slide.imageConvertFailed"),
      });
      const title = file.name.replace(/\.[^.]+$/, "") || before?.title || t("chat.slide", { index });
      const uploaded = await uploadProjectSlide(projectId, index, png, title);
      onSlides((items) => items.map((slide) => (slide.index === index ? uploaded : slide)));
      setSelected(index);
    } catch (error: any) {
      update(index, {
        status: before?.image ? "rendered" : "pending",
        error: undefined,
      });
      setActionError(String(error?.message ?? error));
    } finally {
      setBusy(false);
      uploadTarget.current = null;
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  function openTransition(index: number) {
    pick(index);
    setTransitionTarget(index);
  }

  async function chooseTransition(transition: SlideTransition) {
    if (!projectId || transitionTarget == null || transitionSaving) return;
    const target = transitionTarget;
    const previous = slides.find((slide) => slide.index === target)?.transition ?? "none";
    if (previous === transition) return;
    setTransitionSaving(true);
    setActionError("");
    update(target, { transition });
    try {
      await setProjectSlideTransition(projectId, target, transition);
      // The optimistic patch above is already canonical. Replacing the whole
      // deck here would change every slide's image cache key and make it flash.
    } catch (error: any) {
      update(target, { transition: previous });
      setActionError(String(error?.message ?? error));
    } finally {
      setTransitionSaving(false);
    }
  }

  function startMark(index: number) {
    const slide = slides.find((item) => item.index === index);
    if (!slide?.image) return;
    pick(index);
    setActionError("");
    setMarkTarget(index);
  }

  async function submitMark(blob: Blob, note: string) {
    if (!projectId || markTarget == null) return;
    const index = markTarget;
    const slide = slides.find((item) => item.index === index);
    if (!slide) return;
    setActionError("");
    setBusy(true);
    let requestMirrored = false;
    try {
      // Keep the live canvas mounted until its immutable snapshot is safely on
      // disk. If this quick upload fails, the user's marks remain available for
      // the Retry button instead of disappearing.
      const markedImage = await saveMarkSource(projectId, index, blob);
      setMarkTarget(null);
      update(index, { status: "working" });
      if (onStartMarkRun) {
        await onStartMarkRun({ slide, note, source: markedImage });
        return;
      }
      onMarkAgentEvent?.({ type: "request", slide, note, markedImage });
      requestMirrored = true;
      const image = await markSlide(projectId, index, markedImage, note);
      update(index, { status: "rendered", image, bust: Date.now() });
      onMarkAgentEvent?.({ type: "complete", slide, note, image });
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (requestMirrored) {
        update(index, { status: "rendered", error: undefined });
        onMarkAgentEvent?.({ type: "error", slide, note, error: message });
      } else {
        update(index, { status: slide.image ? "rendered" : "pending", error: undefined });
        setActionError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  const playSlides = useMemo(() => slides
    .filter((slide) => slide.image)
    .map((slide) => ({
      index: slide.index,
      url: fileUrl(projectId!, slide.image, slide.bust),
      title: slide.title,
      transition: slide.transition ?? "none",
      speakerNotes: slide.speakerNotes,
    })), [projectId, slides]);

  const playStartIndex = useCallback((fromCurrent: boolean) => {
    if (!fromCurrent || !current || !playSlides.length) return 0;
    const exact = playSlides.findIndex((slide) => slide.index === current.index);
    if (exact >= 0) return exact;
    const following = playSlides.findIndex((slide) => slide.index > current.index);
    return following >= 0 ? following : playSlides.length - 1;
  }, [current, playSlides]);

  function startPlayback(fromCurrent: boolean, presenter: boolean) {
    if (!projectId || !playSlides.length) return;
    let presenterWindow: Window | null = null;
    if (presenter) {
      presenterWindow = window.open(
        "",
        `codex-slides-presenter-${projectId}-${Date.now()}`,
        "popup,width=1320,height=820,minWidth=720,minHeight=620",
      );
      if (!presenterWindow) {
        setActionError(t("presenter.popupBlocked"));
        setPlayOpen(false);
        return;
      }
      presenterWindow.document.title = t("presenter.windowTitle");
      if (presenterWindow.document.body) presenterWindow.document.body.textContent = t("presenter.opening");
    }
    presenterWindowRef.current = presenterWindow;
    setActionError("");
    setPlayOpen(false);
    setPlaySession({ initialIndex: playStartIndex(fromCurrent), presenterWindow });
  }

  // Single teardown for playback: close the presenter popup (if any) and drop
  // the overlay. Used by PlayMode's onClose and by unmount below.
  const endPlayback = useCallback(() => {
    const presenterWindow = presenterWindowRef.current;
    if (presenterWindow && !presenterWindow.closed) {
      try { presenterWindow.close(); } catch { /* window is already closing */ }
    }
    presenterWindowRef.current = null;
    setPlaySession(null);
  }, []);

  useEffect(() => () => {
    // If the stage unmounts mid-presentation, don't leak the popup window.
    const presenterWindow = presenterWindowRef.current;
    if (presenterWindow && !presenterWindow.closed) {
      try { presenterWindow.close(); } catch { /* window is already closing */ }
    }
    presenterWindowRef.current = null;
  }, []);

  useEffect(() => {
    if (!deepLinkAction || handledDeepLinkKey.current === deepLinkAction.key) return;
    if (deepLinkAction.mode === "play" && !playSlides.length) return;
    if (deepLinkAction.mode === "play") {
      const requestedIndex = deepLinkAction.slideIndex
        ? playSlides.findIndex((slide) => slide.index === deepLinkAction.slideIndex)
        : -1;
      presenterWindowRef.current = null;
      setPlaySession({
        initialIndex: requestedIndex >= 0 ? requestedIndex : playStartIndex(true),
        presenterWindow: null,
      });
    } else if (deepLinkAction.mode === "presenter" || deepLinkAction.panel === "play") {
      // Presenter windows require a user gesture. Open the exact Play menu so
      // the remaining click is visible and intentional instead of being blocked.
      setPlayOpen(true);
    } else if (deepLinkAction.panel === "export") {
      setExportOpen(true);
    } else if (deepLinkAction.panel === "speaker-notes") {
      requestAnimationFrame(() => {
        const notes = document.getElementById("speaker-notes-panel");
        notes?.scrollIntoView({ behavior: "smooth", block: "center" });
        notes?.focus({ preventScroll: true });
      });
    }
    handledDeepLinkKey.current = deepLinkAction.key;
    // playSlides is intentionally observed so a play deep link waits until
    // rendered pages are available, then consumes the action exactly once.
  }, [deepLinkAction, playSlides, playStartIndex]);

  async function persistSpeakerNote(index: number, note: string) {
    if (!projectId) throw new Error(t("speakerNotes.unavailable"));
    const result = await saveProjectSpeakerNote(projectId, index, note);
    const saved = result.notes.find((item) => item.index === index)?.note ?? "";
    update(index, { speakerNotes: saved || undefined });
    return saved;
  }

  async function generateSlideNote(index: number, overwrite: boolean) {
    if (!projectId) throw new Error(t("speakerNotes.unavailable"));
    const result = await generateProjectSpeakerNotes(projectId, { index, overwrite });
    const notes = new Map(result.notes.map((item) => [item.index, item.note]));
    onSlides((items) => items.map((slide) => (
      notes.has(slide.index) ? { ...slide, speakerNotes: notes.get(slide.index) || undefined } : slide
    )));
    return notes.get(index) ?? "";
  }
  const transitionLabel = (transition: SlideTransition | undefined) => {
    switch (transition ?? "none") {
      case "fade": return t("transition.fade");
      case "push": return t("transition.push");
      case "wipe": return t("transition.wipe");
      case "zoom": return t("transition.zoom");
      case "flip": return t("transition.flip");
      default: return t("transition.none");
    }
  };

  return (
    <section className="stage" ref={stageRef}>
      <div className={`stage-head${showTitle ? "" : " without-title"}`}>
        {headerPrefix}
        {showTitle ? <span className="title">{title || t("slide.untitled")}</span> : null}
        {!showTitle && title ? <span className="stage-collapsed-title" title={title}>{title}</span> : null}
        <span className="count">
          <span>{currentPosition >= 0 ? currentPosition + 1 : 0}/{slides.length || "…"}</span>
          <span className="stage-count-aspect"> · {aspect}</span>
        </span>

        <div className="stage-actions">
          <div ref={playRef} className="present-wrap">
            <button
              className="iconbtn primary"
              disabled={!rendered}
              onClick={() => setPlayOpen((open) => !open)}
              title={t("slide.presentHelp")}
              aria-haspopup="menu"
              aria-expanded={playOpen}
            >
              <PlayIcon size={16} weight="fill" aria-hidden="true" />
              <span className="stage-action-label">{t("slide.present")}</span>
              <span className="caret">▾</span>
            </button>
            {playOpen && rendered > 0 && (
              <div className="pop down present-pop" role="menu">
                <div className="pop-title">{t("presenter.audiencePlayback")}</div>
                <button type="button" className="pop-item" role="menuitem" onClick={() => startPlayback(true, false)}>
                  <span className="ic">▶</span>
                  <span className="grow"><b>{t("presenter.fromCurrent")}</b><em>{t("presenter.fromCurrentHelp")}</em></span>
                </button>
                <button type="button" className="pop-item" role="menuitem" onClick={() => startPlayback(false, false)}>
                  <span className="ic">↤</span>
                  <span className="grow"><b>{t("presenter.fromBeginning")}</b><em>{t("presenter.fromBeginningHelp")}</em></span>
                </button>
                <div className="present-pop-sep" aria-hidden="true" />
                <div className="pop-title">{t("presenter.mode")}</div>
                <button type="button" className="pop-item" role="menuitem" onClick={() => startPlayback(true, true)}>
                  <span className="ic">▣</span>
                  <span className="grow"><b>{t("presenter.presenterFromCurrent")}</b><em>{t("presenter.modeHelp")}</em></span>
                </button>
                <button type="button" className="pop-item" role="menuitem" onClick={() => startPlayback(false, true)}>
                  <span className="ic">▤</span>
                  <span className="grow"><b>{t("presenter.presenterFromBeginning")}</b><em>{t("presenter.modeHelp")}</em></span>
                </button>
              </div>
            )}
          </div>

          <ExportMenu
            pdfUrl={`/api/projects/${projectId}/export?format=pdf`}
            pptxUrl={`/api/projects/${projectId}/export?format=pptx`}
            disabled={!canExport}
            open={exportOpen}
            onOpenChange={setExportOpen}
          />

          {headerExtra && <span className="stage-actions-sep" />}
          {headerExtra}
        </div>
      </div>

      <div className="stage-main">
        {current && (
          <>
            <button className="stage-page-nav prev" onClick={() => movePage(-1)} disabled={currentPosition <= 0} aria-label={t("slide.previous")}>‹</button>
            <button className="stage-page-nav next" onClick={() => movePage(1)} disabled={currentPosition < 0 || currentPosition >= slides.length - 1} aria-label={t("slide.next")}>›</button>
          </>
        )}

        {current && (
          <div className="slide-toolbar" role="toolbar" aria-label={t("slide.tools", { index: current.index })}>
            <span className="slide-toolbar-page">{t("chat.slide", { index: current.index })}</span>
            <span className="slide-toolbar-sep" aria-hidden="true" />
            <button
              type="button"
              className="slide-toolbar-tooltip"
              onClick={() => askAgent(current.index)}
              disabled={!canEdit}
              aria-label={t("slide.askAiHelp")}
              data-tooltip={t("slide.askAiHelp")}
            >
              <Sparkle size={16} />
              <span>{t("slide.askAi")}</span>
            </button>
            <button
              type="button"
              className="slide-toolbar-tooltip"
              onClick={() => startMark(current.index)}
              disabled={!canEdit || !current.image}
              aria-label={t("slide.markHelp")}
              data-tooltip={t("slide.markHelp")}
            >
              <PencilSimple size={16} />
              <span>{t("slide.mark")}</span>
            </button>
            <button type="button" className="icon-only slide-toolbar-tooltip" onClick={() => openTransition(current.index)} disabled={!canEdit} data-tooltip={t("slide.transitionHelp")} aria-label={t("slide.transitionHelp")}>
              <FilmStrip size={16} />
            </button>
            <button
              type="button"
              className="icon-only slide-toolbar-tooltip"
              onClick={() => chooseUpload(current.index)}
              disabled={!canEdit}
              data-tooltip={current.image ? t("slide.replaceHelp") : t("slide.uploadHelp")}
              aria-label={current.image ? t("slide.replaceHelp") : t("slide.uploadHelp")}
            >
              <Image size={16} />
            </button>
            <button type="button" className="icon-only slide-toolbar-tooltip" onClick={() => void reorderPage(current.index, -1)} disabled={!canEdit || current.index <= 1} data-tooltip={t("slide.moveLeftHelp")} aria-label={t("slide.moveLeftHelp")}>
              <ArrowLeft size={16} />
            </button>
            <button type="button" className="icon-only slide-toolbar-tooltip" onClick={() => void reorderPage(current.index, 1)} disabled={!canEdit || current.index >= slides.length} data-tooltip={t("slide.moveRightHelp")} aria-label={t("slide.moveRightHelp")}>
              <ArrowRight size={16} />
            </button>
            <button type="button" className="icon-only slide-toolbar-tooltip" onClick={() => duplicatePage(current.index)} disabled={!canEdit} data-tooltip={t("slide.duplicateHelp")} aria-label={t("slide.duplicateHelp")}>
              <Copy size={16} />
            </button>
            <span className="slide-toolbar-sep" aria-hidden="true" />
            <button type="button" className="danger icon-only slide-toolbar-tooltip" onClick={() => deletePage(current.index)} disabled={!canEdit} data-tooltip={t("slide.deleteHelp")} aria-label={t("slide.deleteHelp")}>
              <Trash size={16} />
            </button>
          </div>
        )}

        <div
          className={`preview${current?.index === enteringSlide ? " slide-enter" : ""}`}
          style={{ ["--ar" as any]: arCss }}
        >
          {current?.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fileUrl(projectId!, current.image, current.bust)}
              alt={current.title}
              decoding="async"
              fetchPriority="high"
            />
          ) : current?.status === "working" ? (
            <SlideSkeleton caption={t("slide.drawing", { index: current.index, title: current.title ? ` — ${current.title}` : "" })} />
          ) : current?.status === "error" ? (
            <div className="slide-empty-state slide-error-state">
              <span className="slide-empty-icon slide-error-icon" aria-hidden>⚠</span>
              <h3>{t("slide.renderFailed")}</h3>
              <p>{current.error || t("slide.emptyBody")}</p>
              <div className="slide-empty-actions">
                <button onClick={() => askAgent(current.index)} disabled={!canEdit}>
                  <span>✦</span><b>{t("slide.retry")}</b><small>{t("slide.continueChat")}</small>
                </button>
                <button onClick={() => chooseUpload(current.index)} disabled={!canEdit}>
                  <span>↥</span><b>{t("slide.upload")}</b><small>{t("slide.formats")}</small>
                </button>
              </div>
              {actionError && <div className="slide-action-error">{actionError}</div>}
            </div>
          ) : current && !streaming ? (
            <div className="slide-empty-state">
              <span className="slide-empty-icon">＋</span>
              <h3>{t("slide.ready", { index: current.index })}</h3>
              <p>{t("slide.emptyBody")}</p>
              <div className="slide-empty-actions">
                <button onClick={() => askAgent(current.index)} disabled={!canEdit}>
                  <span>✦</span><b>{t("slide.askAgent")}</b><small>{t("slide.continueChat")}</small>
                </button>
                <button onClick={() => chooseUpload(current.index)} disabled={!canEdit}>
                  <span>↥</span><b>{t("slide.upload")}</b><small>{t("slide.formats")}</small>
                </button>
              </div>
              {actionError && <div className="slide-action-error">{actionError}</div>}
            </div>
          ) : slides.length ? (
            <SlideSkeleton caption={streaming ? t("slide.queued") : undefined} />
          ) : (
            <div className="slide-empty-state">
              <span className="slide-empty-icon">＋</span>
              <h3>{t("slide.addFirst")}</h3>
              <p>{t("slide.addFirstBody")}</p>
              <button className="add-first-slide" onClick={() => addBlankSlide()} disabled={!canEdit}>{t("slide.add")}</button>
              {actionError && <div className="slide-action-error">{actionError}</div>}
            </div>
          )}

          {addingAfter != null && (
            <div className="slide-structure-progress" role="status" aria-live="polite">
              <span className="spinner sm" />
              <span>{t("slide.adding", { index: addingAfter + 1 })}</span>
            </div>
          )}

          {current?.image && markTarget === current.index && (
            <MarkCanvas
              imageUrl={fileUrl(projectId!, current.image, current.bust)}
              slideIndex={current.index}
              busy={busy}
              error={actionError}
              onCancel={() => setMarkTarget(null)}
              onSubmit={submitMark}
            />
          )}
        </div>

        <SpeakerNotesPanel
          slide={current}
          disabled={!canEdit}
          onSave={persistSpeakerNote}
          onGenerate={generateSlideNote}
        />
      </div>

      <div className="filmstrip" ref={stripRef}>
        {slides.map((slide, position) => (
          <Fragment key={slide.index}>
            <div
              className={`frame-shell${slide.index === selected ? " selected" : ""}${slide.index === enteringSlide ? " frame-enter" : ""}`}
              data-slide-index={slide.index}
            >
              <button
                className={`frame ${slide.index === selected ? "on" : ""} ${slide.status}`}
                onClick={() => pick(slide.index)}
                title={t("slide.select", { title: slide.title || t("chat.slide", { index: slide.index }) })}
              >
                <div className="thumb" style={{ ["--ar" as any]: arCss }}>
                  {slide.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={fileUrl(projectId!, slide.image, slide.bust)}
                      alt={slide.title}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : slide.status === "error" ? (
                    <span className="mini-ph">⚠</span>
                  ) : slide.status === "working" ? (
                    <span className="skeleton skel-thumb"><span className="spinner sm" /></span>
                  ) : (
                    <span className="frame-blank-mark">＋</span>
                  )}
                </div>
                <span className="idx"><span className={`fdot ${slide.status}`} />{slide.index} / {slides.length}</span>
              </button>
              <button
                className={`frame-transition${slide.transition && slide.transition !== "none" ? " active" : ""}`}
                aria-label={t("slide.transitionState", { index: slide.index, transition: transitionLabel(slide.transition) })}
                title={t("slide.transitionTitle", { transition: transitionLabel(slide.transition) })}
                onClick={() => openTransition(slide.index)}
                disabled={!canEdit}
              >
                <FilmStrip size={13} />
              </button>
            </div>
            {position < slides.length - 1 && (
              <button className="frame-insert" onClick={() => addBlankSlide(slide.index)} disabled={!canEdit} aria-label={t("slide.addAfter", { index: slide.index })}><Plus size={15} /></button>
            )}
            {addingAfter === slide.index && (
              <div className="frame-shell frame-shell-adding" aria-hidden="true">
                <div className="frame frame-pending-add">
                  <div className="thumb" style={{ ["--ar" as any]: arCss }}>
                    <span className="spinner sm" />
                  </div>
                </div>
              </div>
            )}
          </Fragment>
        ))}
        {addingAfter === 0 && slides.length === 0 && (
          <div className="frame-shell frame-shell-adding" aria-hidden="true">
            <div className="frame frame-pending-add">
              <div className="thumb" style={{ ["--ar" as any]: arCss }}>
                <span className="spinner sm" />
              </div>
            </div>
          </div>
        )}
        <button className="frame-add" onClick={() => addBlankSlide()} disabled={!canEdit} aria-label={t("slide.add")}>
          <Plus size={22} /><small>{t("slide.add")}</small>
        </button>
      </div>

      {transitionTarget != null && (
        <TransitionPicker
          slideIndex={transitionTarget}
          value={slides.find((slide) => slide.index === transitionTarget)?.transition ?? "none"}
          saving={transitionSaving}
          error={actionError}
          onSelect={chooseTransition}
          onClose={() => setTransitionTarget(null)}
        />
      )}

      <input
        ref={uploadRef}
        className="slide-upload-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => handleUpload(event.target.files?.[0])}
      />

      {playSession && projectId && (
        <PlayMode
          slides={playSlides}
          initialIndex={playSession.initialIndex}
          projectId={projectId}
          deckTitle={title}
          presenterWindow={playSession.presenterWindow}
          onSpeakerNotesChange={persistSpeakerNote}
          onClose={endPlayback}
        />
      )}
    </section>
  );
}

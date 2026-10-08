"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkle } from "@phosphor-icons/react";
import { useI18n } from "@/i18n/I18nProvider";
import type { UiSlide } from "@/lib/deckEdit";

/** Every slide owns an always-editable note field. Writes are debounced and
 * serialized per page so switching quickly can never discard an intermediate
 * slide's note or let an older request overwrite newer typing. */
export default function SpeakerNotesPanel({
  slide,
  disabled,
  onSave,
  onGenerate,
}: {
  slide?: UiSlide;
  disabled: boolean;
  onSave: (index: number, note: string) => Promise<string>;
  onGenerate: (index: number, overwrite: boolean) => Promise<string>;
}) {
  const { t } = useI18n();
  const note = slide?.speakerNotes ?? "";
  const [draft, setDraft] = useState(note);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState<"saved" | "generated" | "error" | null>(null);
  const [error, setError] = useState("");
  const onSaveRef = useRef(onSave);
  const mountedRef = useRef(true);
  const currentIndexRef = useRef<number | null>(slide?.index ?? null);
  const draftRef = useRef(note);
  const savedValuesRef = useRef(new Map<number, string>(slide ? [[slide.index, note]] : []));
  const pendingRef = useRef(new Map<number, string>());
  const writingRef = useRef(new Map<number, string>());
  const saveTaskRef = useRef<Promise<void> | null>(null);

  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  function queueSave(index: number, value: string) {
    const pendingValue = pendingRef.current.get(index);
    const writingValue = writingRef.current.get(index);
    if (pendingValue === value || (writingValue === value && pendingValue === undefined)) {
      return saveTaskRef.current ?? Promise.resolve();
    }
    if (savedValuesRef.current.get(index) === value && pendingValue === undefined && writingValue === undefined) {
      return saveTaskRef.current ?? Promise.resolve();
    }
    pendingRef.current.set(index, value);
    if (!saveTaskRef.current) {
      saveTaskRef.current = (async () => {
        if (mountedRef.current) setSaving(true);
        while (pendingRef.current.size) {
          const pending = pendingRef.current.entries().next().value as [number, string] | undefined;
          if (!pending) break;
          const [pendingIndex, pendingValue] = pending;
          pendingRef.current.delete(pendingIndex);
          writingRef.current.set(pendingIndex, pendingValue);
          try {
            const saved = await onSaveRef.current(pendingIndex, pendingValue);
            savedValuesRef.current.set(pendingIndex, saved);
            if (mountedRef.current && currentIndexRef.current === pendingIndex && draftRef.current === pendingValue) {
              draftRef.current = saved;
              setDraft(saved);
              setStatus("saved");
              setError("");
            }
          } catch (reason: unknown) {
            if (mountedRef.current && currentIndexRef.current === pendingIndex) {
              setStatus("error");
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          } finally {
            if (writingRef.current.get(pendingIndex) === pendingValue) writingRef.current.delete(pendingIndex);
          }
        }
      })().finally(() => {
        saveTaskRef.current = null;
        if (mountedRef.current) setSaving(false);
        // A value can be queued between the loop's last size check and finally.
        const next = pendingRef.current.entries().next().value as [number, string] | undefined;
        if (next) void queueSave(next[0], next[1]);
      });
    }
    return saveTaskRef.current;
  }

  useEffect(() => {
    if (!slide) return;
    const previousIndex = currentIndexRef.current;
    const previousDraft = draftRef.current;
    if (previousIndex !== slide.index) {
      if (previousIndex != null && savedValuesRef.current.get(previousIndex) !== previousDraft) {
        void queueSave(previousIndex, previousDraft);
      }
      currentIndexRef.current = slide.index;
      savedValuesRef.current.set(slide.index, note);
      draftRef.current = note;
      setDraft(note);
      setStatus(null);
      setError("");
      return;
    }

    const previousSaved = savedValuesRef.current.get(slide.index);
    savedValuesRef.current.set(slide.index, note);
    if (draftRef.current === previousSaved) {
      draftRef.current = note;
      setDraft(note);
    }
  // `note` is the server value for the current page; queueSave reads callbacks from refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, slide?.index]);

  useEffect(() => {
    if (!slide || disabled || generating || savedValuesRef.current.get(slide.index) === draft) return;
    const timer = window.setTimeout(() => { void queueSave(slide.index, draft); }, 700);
    return () => window.clearTimeout(timer);
  // queueSave deliberately reads the latest callback from a ref.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, draft, generating, slide?.index]);

  useEffect(() => {
    if (status !== "saved" && status !== "generated") return;
    const timer = window.setTimeout(() => setStatus(null), 2600);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => () => {
    mountedRef.current = false;
    const index = currentIndexRef.current;
    if (index != null && savedValuesRef.current.get(index) !== draftRef.current) {
      void queueSave(index, draftRef.current);
    }
  }, []);

  async function generate() {
    if (!slide || disabled || generating) return;
    setGenerating(true);
    setStatus(null);
    setError("");
    try {
      await queueSave(slide.index, draftRef.current);
      const generated = await onGenerate(slide.index, Boolean(draftRef.current.trim()));
      savedValuesRef.current.set(slide.index, generated);
      currentIndexRef.current = slide.index;
      draftRef.current = generated;
      setDraft(generated);
      setStatus("generated");
    } catch (reason: unknown) {
      setStatus("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setGenerating(false);
    }
  }

  if (!slide) return null;

  return (
    <section id="speaker-notes-panel" className="speaker-notes-panel" aria-label={t("speakerNotes.title")} tabIndex={-1}>
      <header className="speaker-notes-head">
        <div>
          <strong>{t("speakerNotes.title")}</strong>
          <span>{t("speakerNotes.slide", { current: slide.index })}</span>
        </div>
        <div className="speaker-notes-actions">
          {status ? (
            <span className={`speaker-notes-status ${status}`} role="status">
              {status === "saved" ? t("speakerNotes.saved") : status === "generated" ? t("speakerNotes.generated") : t("speakerNotes.failed")}
            </span>
          ) : null}
          <button type="button" onClick={() => void generate()} disabled={disabled || generating || saving}>
            {generating ? <span className="spinner sm" /> : <Sparkle size={14} />}
            {draft.trim() ? t("speakerNotes.regenerate") : t("speakerNotes.generate")}
          </button>
        </div>
      </header>

      <div className="speaker-notes-editor">
        <textarea
          value={draft}
          rows={4}
          maxLength={20_000}
          placeholder={t("speakerNotes.placeholder")}
          disabled={disabled || generating}
          onChange={(event) => {
            draftRef.current = event.currentTarget.value;
            setDraft(event.currentTarget.value);
            setStatus(null);
            setError("");
          }}
          onBlur={() => void queueSave(slide.index, draftRef.current)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void queueSave(slide.index, draftRef.current);
            }
          }}
        />
        {saving ? <span className="speaker-notes-saving"><span className="spinner sm" />{t("speakerNotes.saving")}</span> : null}
      </div>
      {error ? <div className="speaker-notes-error" role="alert">{error}</div> : null}
    </section>
  );
}

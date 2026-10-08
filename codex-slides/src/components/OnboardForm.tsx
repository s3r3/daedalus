"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon } from "@phosphor-icons/react";
import type { QuestionSpec } from "@/lib/onboard";
import { uploadContextItems, type ContextItem } from "@/lib/contextItems";
import type { ClarifyFormState, PptConfig } from "@/lib/types";
import { semanticOptionLabel } from "@/lib/questionSemantics";
import { useI18n } from "@/i18n/I18nProvider";

/** Renders the agent-generated clarifying questions as a dynamic form (M2 / step 1).
 *  Every question accepts a free-text custom answer AND reference images, which are
 *  attached as materials the pipeline consumes (image → PPT reference). */
export default function OnboardForm({
  questions,
  busy,
  onCancel,
  onComplete,
  onAttachImages,
  onRemoveImage,
  submitLabel,
  skipLabel,
  initialState,
  availableImages = [],
  onStateChange,
}: {
  questions: QuestionSpec[];
  busy: boolean;
  onCancel: () => void;
  onComplete: (patch: Partial<PptConfig>, requirementSuffix: string, summary: string) => void;
  /** Push newly attached reference images up to the shared materials list. */
  onAttachImages?: (items: ContextItem[]) => void;
  /** Remove a previously attached reference image from the shared materials list. */
  onRemoveImage?: (id: string) => void;
  /** Override the primary button copy (staged flow continues to the outline, not straight to generate). */
  submitLabel?: string;
  skipLabel?: string;
  /** Restored answers for a clarification checkpoint. */
  initialState?: ClarifyFormState;
  /** Project-owned images used to restore per-question attachments. */
  availableImages?: ContextItem[];
  onStateChange?: (state: ClarifyFormState) => void;
}) {
  const { t } = useI18n();
  const initial = useMemo(() => {
    const a: Record<string, string | string[]> = {};
    for (const q of questions) {
      if (q.type === "multi") a[q.id] = [];
      else a[q.id] = q.recommended ?? "";
    }
    return { ...a, ...(initialState?.answers ?? {}) };
  }, [initialState?.answers, questions]);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(initial);
  const [custom, setCustom] = useState<Record<string, string>>(initialState?.custom ?? {});
  const [images, setImages] = useState<Record<string, ContextItem[]>>(() => Object.fromEntries(
    Object.entries(initialState?.images ?? {}).map(([questionId, ids]) => [
      questionId,
      ids.flatMap((id) => availableImages.find((item) => item.id === id) ?? []),
    ]),
  ));
  const [uploadingQ, setUploadingQ] = useState<string | null>(null);
  const [attachError, setAttachError] = useState("");
  const onStateChangeRef = useRef(onStateChange);

  useEffect(() => {
    setAnswers((current) => {
      const next = { ...current };
      for (const question of questions) {
        if (next[question.id] !== undefined) continue;
        next[question.id] = question.type === "multi" ? [] : question.recommended ?? "";
      }
      return next;
    });
  }, [questions]);

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    setAnswers((current) => {
      let changed = false;
      const next = { ...current };
      for (const question of questions) {
        if (question.id in next) continue;
        next[question.id] = question.type === "multi" ? [] : question.recommended ?? "";
        changed = true;
      }
      return changed ? next : current;
    });
  }, [questions]);

  useEffect(() => {
    onStateChangeRef.current?.({
      answers,
      custom,
      images: Object.fromEntries(Object.entries(images).map(([questionId, items]) => [
        questionId,
        items.map((item) => item.id),
      ])),
    });
  }, [answers, custom, images]);

  function setOne(id: string, v: string | string[]) {
    setAnswers((a) => ({ ...a, [id]: v }));
  }
  function toggleMulti(id: string, v: string) {
    setAnswers((a) => {
      const cur = Array.isArray(a[id]) ? (a[id] as string[]) : [];
      return { ...a, [id]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
    });
  }
  /** Picking a preset clears any custom text so the choice is unambiguous. */
  function pickOption(id: string, v: string) {
    setOne(id, v);
    setCustom((c) => ({ ...c, [id]: "" }));
  }
  function setCustomText(id: string, text: string, type: QuestionSpec["type"]) {
    setCustom((c) => ({ ...c, [id]: text }));
    if (type === "single") setOne(id, text); // single answer follows the custom box live
  }

  function customPlaceholder(q: QuestionSpec) {
    const supplied = q.placeholder?.trim();
    if (!supplied || /\u968f\u610f\u8f93\u5165|anything|free.?form/i.test(supplied)) return t("onboard.customInput");
    return supplied;
  }

  async function addImages(qid: string, fileList: FileList | null) {
    const files = Array.from(fileList ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    setUploadingQ(qid);
    setAttachError("");
    const result = await uploadContextItems(files);
    if (result.items.length) {
      setImages((m) => ({ ...m, [qid]: [...(m[qid] ?? []), ...result.items] }));
      onAttachImages?.(result.items);
    }
    if (result.errors.length) setAttachError(result.errors.join(" · "));
    setUploadingQ(null);
  }
  function removeImage(qid: string, id: string) {
    setImages((m) => ({ ...m, [qid]: (m[qid] ?? []).filter((it) => it.id !== id) }));
    onRemoveImage?.(id);
  }

  /** Effective answer for a question, folding in any custom free-text. */
  function effective(q: QuestionSpec): string | string[] {
    const c = (custom[q.id] ?? "").trim();
    if (q.type === "multi") {
      const arr = Array.isArray(answers[q.id]) ? [...(answers[q.id] as string[])] : [];
      if (c) arr.push(c);
      return arr;
    }
    if (q.type === "single") return c || String(answers[q.id] ?? "");
    return String(answers[q.id] ?? "");
  }

  function submit() {
    const patch: Partial<PptConfig> = {};
    const prefs: string[] = [];
    const summaryParts: string[] = [];
    for (const q of questions) {
      const val = effective(q);
      const asStr = Array.isArray(val) ? val.join(", ") : String(val ?? "");
      const imgs = images[q.id] ?? [];
      const label = q.question.replace(/[?？]\s*$/, "");
      if (!asStr && !imgs.length) continue;
      const chosen = (Array.isArray(val) ? val : [val])
        .filter(Boolean)
        .map((v) => {
          const option = (q.options ?? []).find((item) => item.value === v);
          return option ? semanticOptionLabel(q, option) : String(v);
        });
      const summaryBits = [...chosen];
      if (imgs.length) summaryBits.push(t("onboard.imageCount", { count: imgs.length }));
      if (summaryBits.length) summaryParts.push(`${label}：${summaryBits.join("、")}`);
      if (imgs.length) prefs.push(`${label}: user attached ${imgs.length} reference image(s) — honor them.`);
      if (!asStr) continue;
      switch (q.field) {
        case "pages":
          patch.pages = Math.max(1, Math.min(30, Number(asStr) || 6));
          break;
        case "aspect":
          patch.aspect = asStr as PptConfig["aspect"];
          break;
        case "resolution":
          patch.resolution = asStr.toUpperCase() as PptConfig["resolution"];
          break;
        case "language":
          patch.language = asStr as PptConfig["language"];
          break;
        case "style":
          patch.style = asStr;
          break;
        case "category": {
          // Capture the scenario as CONTENT context only — do NOT auto-assign a
          // visual template here. Leaving config.template unset is what lets the
          // post-outline style-selection (inspiration) step surface community
          // styles when the user hasn't already picked one at the launcher.
          prefs.push(`Deck scenario: ${asStr}`);
          break;
        }
        default: // free content preference
          prefs.push(`${label}: ${asStr}`);
      }
    }
    const suffix = prefs.length ? `\n\nAdditional preferences:\n- ${prefs.join("\n- ")}` : "";
    onComplete(patch, suffix, summaryParts.join("\n"));
  }

  function AttachControl({ q, inline }: { q: QuestionSpec; inline?: boolean }) {
    const imgs = images[q.id] ?? [];
    return (
      <>
        <label className={`onb-attach-btn${inline ? " inline" : ""}`} title={t("onboard.referenceImageHelp")}>
          <ImageIcon size={15} weight="regular" />
          {inline ? "" : <span>{t("onboard.referenceImage")}</span>}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              void addImages(q.id, e.target.files);
              e.currentTarget.value = "";
            }}
          />
        </label>
        {uploadingQ === q.id && <span className="onb-attach-hint">{t("onboard.uploading")}</span>}
        {imgs.length > 0 && (
          <div className="onb-thumbs">
            {imgs.map((it) => (
              <span className="onb-thumb" key={it.id} title={it.name}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.url} alt={it.name} />
                <button type="button" aria-label={t("onboard.removeImage", { name: it.name })} onClick={() => removeImage(q.id, it.id)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="panel onb-panel">
      <h2>{t("onboard.title")}</h2>
      {questions.map((q) => (
        <div className="field onb-field" key={q.id}>
          <span className="onb-q">{q.question}</span>
          {q.type === "number" && (
            <div className="onb-options">
              <input
                type="number"
                min={1}
                max={30}
                value={String(answers[q.id] ?? "")}
                onChange={(e) => setOne(q.id, e.target.value)}
              />
              <AttachControl q={q} inline />
            </div>
          )}
          {q.type === "text" && (
            <div className="onb-options">
              <input
                className="onb-custom"
                placeholder={customPlaceholder(q)}
                value={String(answers[q.id] ?? "")}
                onChange={(e) => setOne(q.id, e.target.value)}
              />
              <AttachControl q={q} inline />
            </div>
          )}
          {q.type === "single" && (
            <div className="onb-options">
              {(q.options ?? []).map((o) => {
                const active = !(custom[q.id] ?? "").trim() && answers[q.id] === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    className={`onb-opt ${active ? "primary" : "ghost"}`}
                    onClick={() => pickOption(q.id, o.value)}
                  >
                    {semanticOptionLabel(q, o)}
                    {q.recommended === o.value ? <span className="onb-recommended" aria-hidden="true">★</span> : null}
                  </button>
                );
              })}
              <input
                className="onb-custom"
                placeholder={t("onboard.customInput")}
                value={custom[q.id] ?? ""}
                onChange={(e) => setCustomText(q.id, e.target.value, "single")}
              />
              <AttachControl q={q} inline />
            </div>
          )}
          {q.type === "multi" && (
            <div className="onb-options">
              {(q.options ?? []).map((o) => {
                const active = Array.isArray(answers[q.id]) && (answers[q.id] as string[]).includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    className={`onb-opt ${active ? "primary" : "ghost"}`}
                    onClick={() => toggleMulti(q.id, o.value)}
                  >
                    {o.label}
                  </button>
                );
              })}
              <input
                className="onb-custom"
                placeholder={t("onboard.customInput")}
                value={custom[q.id] ?? ""}
                onChange={(e) => setCustomText(q.id, e.target.value, "multi")}
              />
              <AttachControl q={q} inline />
            </div>
          )}
        </div>
      ))}
      {busy && (
        <div className="onb-streaming-tail" aria-live="polite">
          <span className="spinner sm" />
          <span>{t("onboard.preparing")}</span>
        </div>
      )}
      {attachError && <div className="onb-attach-error" role="alert">{attachError}</div>}
      <div className="onb-actions">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          {skipLabel ?? t("onboard.skip")}
        </button>
        <button className="primary" style={{ width: "auto", flex: 1 }} onClick={submit} disabled={busy || !!uploadingQ}>
          {busy ? "…" : submitLabel ?? t("onboard.apply")}
        </button>
      </div>
    </div>
  );
}

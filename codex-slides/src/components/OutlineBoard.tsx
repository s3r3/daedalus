"use client";

import { Fragment, useState, type ReactNode } from "react";
import type { OutlinePage } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

/**
 * Step 3-4 of the staged flow (编辑大纲 → 确认): an editable outline shown in the
 * right stage while the deck is still a draft. Titles/points are editable, pages
 * can be reordered/added/removed, and a prominent bar confirms → per-page render.
 */
export default function OutlineBoard({
  title,
  aspect,
  outline,
  onChange,
  onConfirm,
  busy = false,
  streaming = false,
  showTitle = true,
  researchDoc,
  headerPrefix,
  headerExtra,
}: {
  title: string;
  aspect: string;
  outline: OutlinePage[];
  onChange: (pages: OutlinePage[]) => void;
  onConfirm: () => void;
  /** true while the render is being kicked off (locks editing). */
  busy?: boolean;
  /** true while the outline is still being written by the agent. */
  streaming?: boolean;
  /** The shared workspace header can own the project title instead. */
  showTitle?: boolean;
  researchDoc?: string;
  headerPrefix?: ReactNode;
  headerExtra?: ReactNode;
}) {
  const { t } = useI18n();
  const [showBrief, setShowBrief] = useState(false);
  const editable = !busy && !streaming;
  const count = outline.length;

  function setTitle(i: number, value: string) {
    onChange(outline.map((p, idx) => (idx === i ? { ...p, title: value } : p)));
  }
  function setPoints(i: number, text: string) {
    onChange(outline.map((p, idx) => (idx === i ? { ...p, points: text.split("\n") } : p)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= count) return;
    const next = [...outline];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  function remove(i: number) {
    if (count <= 1) return;
    onChange(outline.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...outline, { title: "", points: [] }]);
  }
  function insertAt(i: number) {
    const next = [...outline];
    next.splice(i, 0, { title: "", points: [] });
    onChange(next);
  }

  return (
    <section className="stage outline-stage">
      <div className={`stage-head${showTitle ? "" : " without-title"}`}>
        {headerPrefix}
        {showTitle ? <span className="title">{title || t("outline.draft")}</span> : null}
        {!showTitle && title ? <span className="stage-collapsed-title" title={title}>{title}</span> : null}
        <span className="count">{t("outline.pageCount", { count, aspect })}</span>
        <div className="stage-actions">
          {headerExtra}
          <button
            className="iconbtn primary"
            disabled={!editable || count === 0}
            onClick={onConfirm}
            title={t("outline.generateHelp")}
          >
            {t("outline.generate", { count })}
          </button>
        </div>
      </div>

      <div className="outline-board">
        <p className="outline-hint">
          {t("outline.hint")}
        </p>

        {researchDoc && (
          <div className="outline-brief">
            <button className="outline-brief-toggle" onClick={() => setShowBrief((v) => !v)}>
              📄 {t("outline.brief")} <span className="caret">{showBrief ? "▴" : "▾"}</span>
            </button>
            {showBrief && <pre className="outline-brief-body">{researchDoc}</pre>}
          </div>
        )}

        {streaming && count === 0 ? (
          <div className="outline-skeleton">
            {[0, 1, 2, 3].map((k) => (
              <span className="skeleton skel-line" key={k} />
            ))}
          </div>
        ) : (
          <ol className="outline-list">
            {outline.map((p, i) => (
              <Fragment key={i}>
                <li className="outline-card">
                  <div className="outline-card-head">
                    <span className="outline-idx">{i + 1}</span>
                    <input
                      className="outline-title"
                      value={p.title}
                      placeholder={t("outline.pageTitle", { index: i + 1 })}
                      disabled={!editable}
                      onChange={(e) => setTitle(i, e.target.value)}
                    />
                    <div className="outline-card-actions">
                      <button disabled={!editable || i === 0} onClick={() => move(i, -1)} title={t("outline.moveUp")} aria-label={t("outline.moveUp")}>↑</button>
                      <button disabled={!editable || i === count - 1} onClick={() => move(i, 1)} title={t("outline.moveDown")} aria-label={t("outline.moveDown")}>↓</button>
                      <button className="danger" disabled={!editable || count <= 1} onClick={() => remove(i)} title={t("outline.delete")} aria-label={t("outline.delete")}>✕</button>
                    </div>
                  </div>
                  <textarea
                    className="outline-points"
                    rows={Math.max(2, p.points.length)}
                    value={p.points.join("\n")}
                    placeholder={t("outline.pointsPlaceholder")}
                    disabled={!editable}
                    onChange={(e) => setPoints(i, e.target.value)}
                  />
                </li>
                {i < count - 1 && (
                  <li className="outline-insert-row">
                    <button
                      className="outline-insert"
                      disabled={!editable}
                      onClick={() => insertAt(i + 1)}
                      title={t("outline.insert")}
                      aria-label={t("outline.insertAfter", { index: i + 1 })}
                    >
                      ＋
                    </button>
                  </li>
                )}
              </Fragment>
            ))}
            {streaming && (
              <li className="outline-streaming-tail" aria-live="polite">
                <span className="spinner sm" />
                <span>{t("outline.streaming")}</span>
              </li>
            )}
          </ol>
        )}

        {!streaming && (
          <button className="outline-add" disabled={!editable} onClick={add}>
            {t("outline.add")}
          </button>
        )}
      </div>

      <div className="outline-confirm">
        <div className="outline-confirm-info">
          <span className="outline-confirm-count">
            {streaming ? t("outline.streamingCount", { count }) : t("outline.ready", { count })}
          </span>
          <small>{streaming ? t("outline.streamingHint") : t("outline.timeHint")}</small>
        </div>
        <button className="outline-confirm-btn" disabled={!editable || count === 0} onClick={onConfirm}>
          {busy ? t("outline.generating") : t("outline.generateSlides", { count })}
        </button>
      </div>
    </section>
  );
}

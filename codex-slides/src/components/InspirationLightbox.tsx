"use client";

import { CaretLeft, CaretRight, Check, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "@/i18n/I18nProvider";
import { COMMUNITY_GROUP_KEYS } from "@/i18n/community";
import {
  getCommunitySource,
  type CommunityTemplate,
} from "@/lib/community";

export default function InspirationLightbox({
  templates,
  activeId,
  selectedId,
  onNavigate,
  onSelect,
  onClose,
}: {
  templates: CommunityTemplate[];
  activeId: string;
  selectedId?: string;
  onNavigate: (templateId: string) => void;
  onSelect: (templateId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Freeze the current browse order while the lightbox is open. The background
  // Codex ranking may finish during preview; applying that reorder mid-browse
  // would make the counter and previous/next neighbors jump unexpectedly.
  const browseTemplates = useRef(templates).current;
  const currentIndex = Math.max(0, browseTemplates.findIndex((item) => item.id === activeId));
  const template = browseTemplates[currentIndex];
  const source = useMemo(
    () => template?.sourceIds?.map(getCommunitySource).find(Boolean),
    [template],
  );
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < browseTemplates.length - 1;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft" && hasPrevious) {
        event.preventDefault();
        onNavigate(browseTemplates[currentIndex - 1].id);
        return;
      }
      if (event.key === "ArrowRight" && hasNext) {
        event.preventDefault();
        onNavigate(browseTemplates[currentIndex + 1].id);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [browseTemplates, currentIndex, hasNext, hasPrevious, onClose, onNavigate]);

  if (!template) return null;

  return (
    <div
      className="inspiration-lightbox-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="inspiration-lightbox"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspiration-lightbox-title"
      >
        <header className="inspiration-lightbox-head">
          <div className="inspiration-lightbox-count" aria-live="polite">
            <span>{t("inspire.preview")}</span>
            <strong>{currentIndex + 1} / {browseTemplates.length}</strong>
          </div>
          <span className="inspiration-lightbox-key-hint">{t("inspire.previewKeyHint")}</span>
          <button
            ref={closeRef}
            type="button"
            className="inspiration-lightbox-close"
            onClick={onClose}
            aria-label={t("inspire.closePreview")}
          >
            <X size={20} weight="bold" />
          </button>
        </header>

        <div className="inspiration-lightbox-stage">
          <button
            type="button"
            className="inspiration-lightbox-nav previous"
            disabled={!hasPrevious}
            onClick={() => hasPrevious && onNavigate(browseTemplates[currentIndex - 1].id)}
            aria-label={t("inspire.previousPreview")}
          >
            <CaretLeft size={30} weight="bold" />
          </button>

          <figure className="inspiration-lightbox-figure">
            <div className="inspiration-lightbox-image-wrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={template.cover} alt={template.name} />
            </div>
          </figure>

          <button
            type="button"
            className="inspiration-lightbox-nav next"
            disabled={!hasNext}
            onClick={() => hasNext && onNavigate(browseTemplates[currentIndex + 1].id)}
            aria-label={t("inspire.nextPreview")}
          >
            <CaretRight size={30} weight="bold" />
          </button>
        </div>

        <footer className="inspiration-lightbox-foot">
          <div className="inspiration-lightbox-copy">
            <div className="inspiration-lightbox-title-row">
              <h2 id="inspiration-lightbox-title">{template.name}</h2>
              <span>{t(COMMUNITY_GROUP_KEYS[template.group])}</span>
            </div>
            <p>{template.description}</p>
            {source ? (
              <a href={template.sourceUrl ?? source.url} target="_blank" rel="noreferrer">
                {t("inspire.sourceMeta", { source: source.name, license: source.license })}
              </a>
            ) : null}
          </div>
          <button
            type="button"
            className={`inspiration-lightbox-select ${selectedId === template.id ? "selected" : ""}`}
            disabled={selectedId === template.id}
            onClick={() => onSelect(template.id)}
          >
            {selectedId === template.id ? <Check size={17} weight="bold" /> : null}
            {selectedId === template.id
              ? t("inspire.previewSelected")
              : t("inspire.selectNamed", { name: template.name })}
          </button>
        </footer>
      </section>
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ImageSquare, X } from "@phosphor-icons/react";
import { useI18n } from "@/i18n/I18nProvider";

export default function ImagePreviewDialog({
  src,
  title,
  subtitle,
  onClose,
}: {
  src: string;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="image-preview-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="image-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="image-preview-title">
        <header className="image-preview-head">
          <span className="image-preview-icon" aria-hidden="true">
            <ImageSquare size={18} />
          </span>
          <span className="image-preview-copy">
            <strong id="image-preview-title">{title}</strong>
            {subtitle && <small>{subtitle}</small>}
          </span>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("dialog.closePreview")}>
            <X size={18} weight="bold" />
          </button>
        </header>
        <div className="image-preview-body">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={title} />
        </div>
      </section>
    </div>,
    document.body,
  );
}

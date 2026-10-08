"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle,
  DownloadSimple,
  FilePdf,
  MicrosoftPowerpointLogo,
  WarningCircle,
} from "@phosphor-icons/react";
import { useI18n } from "@/i18n/I18nProvider";

type ExportFormat = "pdf" | "pptx";

function exportedFilename(response: Response, format: ExportFormat) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8); } catch { /* use the quoted fallback */ }
  }
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  return quoted || `presentation.${format}`;
}

/** Shared export control for the live deck and immutable version previews.
 * Fetching the file keeps a visible progress toast on screen for slow exports. */
export default function ExportMenu({
  pdfUrl,
  pptxUrl,
  disabled = false,
  buttonClassName = "iconbtn",
  wrapperClassName = "",
  open: controlledOpen,
  onOpenChange,
}: {
  pdfUrl: string;
  pptxUrl: string;
  disabled?: boolean;
  buttonClassName?: string;
  wrapperClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [internalOpen, setInternalOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [toast, setToast] = useState<{ state: "loading" | "ready" | "error"; format: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean | ((current: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(open) : next;
    if (controlledOpen == null) setInternalOpen(value);
    onOpenChange?.(value);
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!toast || toast.state === "loading") return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function download(format: ExportFormat) {
    if (exporting) return;
    const label = format === "pdf" ? "PDF" : "PPTX";
    setOpen(false);
    setExporting(format);
    setToast({ state: "loading", format: label });
    try {
      const response = await fetch(format === "pdf" ? pdfUrl : pptxUrl);
      if (!response.ok) throw new Error((await response.text().catch(() => "")) || `HTTP ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exportedFilename(response, format);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setToast({ state: "ready", format: label });
    } catch {
      setToast({ state: "error", format: label });
    } finally {
      setExporting(null);
    }
  }

  const toastNode = toast ? (
    <div className={`export-toast ${toast.state}`} role="status" aria-live="polite">
      {toast.state === "loading" ? <span className="spinner sm" /> : null}
      {toast.state === "ready" ? <CheckCircle size={18} weight="fill" /> : null}
      {toast.state === "error" ? <WarningCircle size={18} weight="fill" /> : null}
      <span>{t(`export.${toast.state}`, { format: toast.format })}</span>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={`export-wrap export-menu${wrapperClassName ? ` ${wrapperClassName}` : ""}`}>
      <button
        type="button"
        className={buttonClassName}
        disabled={disabled || Boolean(exporting)}
        onClick={() => setOpen((value) => !value)}
        title={t("slide.exportHelp")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {exporting ? <span className="spinner sm" /> : <DownloadSimple size={16} weight="bold" aria-hidden="true" />}
        <span className="stage-action-label">{t("slide.export")}</span>
        <span className="caret">▾</span>
      </button>
      {open && !disabled ? (
        <div className="pop down export-pop" role="menu">
          <div className="pop-title">{t("slide.download")}</div>
          <button type="button" className="pop-item" role="menuitem" onClick={() => void download("pdf")}>
            <span className="ic"><FilePdf size={17} /></span>
            <span className="grow"><b>PDF</b><em>{t("slide.pdfHelp")}</em></span>
          </button>
          <button type="button" className="pop-item" role="menuitem" onClick={() => void download("pptx")}>
            <span className="ic"><MicrosoftPowerpointLogo size={17} /></span>
            <span className="grow"><b>PowerPoint</b><em>{t("slide.pptxHelp")}</em></span>
          </button>
        </div>
      ) : null}
      {typeof document !== "undefined" && toastNode ? createPortal(toastNode, document.body) : null}
    </div>
  );
}

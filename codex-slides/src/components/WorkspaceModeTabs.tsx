"use client";

import { Files, PresentationChart } from "@phosphor-icons/react";
import type { WorkspaceMode } from "@/lib/designFiles";
import { useI18n } from "@/i18n/I18nProvider";

export default function WorkspaceModeTabs({
  mode,
  fileCount = 0,
  onChange,
}: {
  mode: WorkspaceMode;
  fileCount?: number;
  onChange: (mode: WorkspaceMode) => void;
}) {
  const { t } = useI18n();
  return (
    <nav className="workspace-mode-tabs" aria-label={t("designFiles.workspaceViews")}>
      <button
        type="button"
        className={mode === "canvas" ? "active" : ""}
        onClick={() => onChange("canvas")}
        aria-pressed={mode === "canvas"}
      >
        <PresentationChart size={15} />
        <span>{t("designFiles.canvas")}</span>
      </button>
      <button
        type="button"
        className={mode === "files" ? "active" : ""}
        onClick={() => onChange("files")}
        aria-pressed={mode === "files"}
      >
        <Files size={15} />
        <span>{t("designFiles.title")}</span>
        {fileCount > 0 ? <small>{fileCount}</small> : null}
      </button>
    </nav>
  );
}

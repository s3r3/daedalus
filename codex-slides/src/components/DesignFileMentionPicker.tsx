"use client";

import { ArrowClockwise, Check, File, FileCode, FileImage, FileText } from "@phosphor-icons/react";
import { useState } from "react";
import type { ProjectFileRecord } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

interface DesignFileMentionPickerProps {
  files: ProjectFileRecord[];
  query: string;
  loading: boolean;
  activeIndex: number;
  selectedPaths: Set<string>;
  onActiveIndexChange: (index: number) => void;
  onSelect: (file: ProjectFileRecord) => void;
  onRefresh: () => void;
}

function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function FileKindIcon({ kind }: { kind: ProjectFileRecord["kind"] }) {
  if (kind === "image") return <FileImage size={16} />;
  if (kind === "code") return <FileCode size={16} />;
  if (kind === "document" || kind === "data") return <FileText size={16} />;
  return <File size={16} />;
}

export function DesignFileMentionPicker({
  files,
  query,
  loading,
  activeIndex,
  selectedPaths,
  onActiveIndexChange,
  onSelect,
  onRefresh,
}: DesignFileMentionPickerProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"all" | "files">("all");

  return (
    <section className="design-file-mention-picker" aria-label={t("chat.mentionPicker")}>
      <div className="design-file-mention-tabs">
        <div className="design-file-mention-tab-buttons" aria-label={t("chat.contextSources")}>
          <button
            type="button"
            aria-pressed={tab === "all"}
            className={tab === "all" ? "active" : ""}
            onClick={() => setTab("all")}
          >
            {t("chat.allContext")}
          </button>
          <button
            type="button"
            aria-pressed={tab === "files"}
            className={tab === "files" ? "active" : ""}
            onClick={() => setTab("files")}
          >
            {t("designFiles.title")}
          </button>
        </div>
        <button
          type="button"
          className="design-file-mention-refresh"
          onClick={onRefresh}
          aria-label={t("designFiles.refresh")}
          title={t("designFiles.refresh")}
        >
          <ArrowClockwise size={14} />
        </button>
      </div>
      <div className="design-file-mention-section-head">
        <strong>{t("chat.designFilesSection")}</strong>
        <span>{query ? t("chat.filteredFileCount", { count: files.length }) : files.length}</span>
      </div>
      <div className="design-file-mention-list" role="listbox" aria-label={t("designFiles.list")}>
        {loading ? <p className="design-file-mention-empty">{t("designFiles.loading")}</p> : null}
        {!loading && files.map((file, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? "active" : ""}
            key={file.absolutePath}
            onMouseEnter={() => onActiveIndexChange(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(file)}
            title={file.absolutePath}
          >
            <span className={`design-file-mention-icon ${file.kind}`} aria-hidden="true">
              <FileKindIcon kind={file.kind} />
            </span>
            <span className="design-file-mention-copy">
              <strong>{file.name}</strong>
              <small>{file.path} · {sizeLabel(file.size)}</small>
            </span>
            {selectedPaths.has(file.absolutePath) ? (
              <span className="design-file-mention-selected" title={t("chat.contextSelected")}>
                <Check size={13} weight="bold" />
              </span>
            ) : null}
          </button>
        ))}
        {!loading && !files.length ? (
          <p className="design-file-mention-empty">
            {query ? t("chat.noMatchingDesignFiles") : t("designFiles.empty")}
          </p>
        ) : null}
      </div>
      <footer>{t("chat.mentionPickerHelp")}</footer>
    </section>
  );
}

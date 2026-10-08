"use client";

import { File, FileCode, FileImage, FileText, X } from "@phosphor-icons/react";
import type { DesignFileReference } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

interface DesignFileReferenceListProps {
  files: DesignFileReference[];
  compact?: boolean;
  onOpen?: (relativePath: string) => void;
  onRemove?: (path: string) => void;
}

function FileKindIcon({ kind }: { kind?: DesignFileReference["kind"] }) {
  if (kind === "image") return <FileImage size={15} />;
  if (kind === "code") return <FileCode size={15} />;
  if (kind === "document" || kind === "data") return <FileText size={15} />;
  return <File size={15} />;
}

export function DesignFileReferenceList({
  files,
  compact = false,
  onOpen,
  onRemove,
}: DesignFileReferenceListProps) {
  const { t } = useI18n();
  if (!files.length) return null;

  return (
    <div
      className={`design-file-references${compact ? " compact" : ""}`}
      aria-label={t("chat.referencedDesignFiles")}
    >
      {files.map((file) => (
        <div className="design-file-reference" key={file.path} title={file.path}>
          <button
            type="button"
            className="design-file-reference-open"
            disabled={!onOpen}
            onClick={() => onOpen?.(file.relativePath)}
            aria-label={t("chat.openReferencedFile", { name: file.name })}
          >
            <span className={`design-file-reference-icon ${file.kind ?? "other"}`} aria-hidden="true">
              <FileKindIcon kind={file.kind} />
            </span>
            <span className="design-file-reference-copy">
              <strong>@{file.name}</strong>
              <small>{file.relativePath}</small>
            </span>
          </button>
          {onRemove ? (
            <button
              type="button"
              className="design-file-reference-remove"
              onClick={() => onRemove(file.path)}
              aria-label={t("chat.removeReferencedFile", { name: file.name })}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

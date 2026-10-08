"use client";

import { Check, MagnifyingGlass, StackSimple, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectTemplateSummary } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

export default function ProjectTemplatePicker({
  templates,
  selected,
  disabled,
  onSelect,
  onClear,
}: {
  templates: ProjectTemplateSummary[];
  selected?: ProjectTemplateSummary | null;
  disabled?: boolean;
  onSelect: (template: ProjectTemplateSummary) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => normalized
    ? templates.filter((template) => (
        `${template.name}\n${template.description}\n${template.sourceProjectTitle}`
          .toLocaleLowerCase()
          .includes(normalized)
      ))
    : templates, [normalized, templates]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="project-template-picker" ref={rootRef}>
      <button
        type="button"
        className={`cbtn${selected ? " active" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("projectTemplates.pickerHelp")}
      >
        <StackSimple size={15} />
        <span>{selected?.name ?? t("projectTemplates.none")}</span>
        <span className="caret">▾</span>
      </button>
      {open ? (
        <div className="pop up project-template-picker-pop">
          <div className="project-template-picker-head">
            <strong>{t("projectTemplates.pickerTitle")}</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label={t("settings.close")}><X size={14} /></button>
          </div>
          <label className="project-template-picker-search">
            <MagnifyingGlass size={14} />
            <input
              ref={searchRef}
              type="search"
              aria-label={t("projectTemplates.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("projectTemplates.search")}
            />
          </label>
          <div className="project-template-picker-list" role="listbox" aria-label={t("projectTemplates.pickerTitle")}>
            <button
              type="button"
              className={!selected ? "selected" : ""}
              role="option"
              aria-selected={!selected}
              onClick={() => {
                onClear();
                setOpen(false);
              }}
            >
              <span className="project-template-picker-empty"><StackSimple size={18} /></span>
              <span><strong>{t("projectTemplates.none")}</strong><small>{t("projectTemplates.noneHelp")}</small></span>
              {!selected ? <Check size={15} weight="bold" /> : null}
            </button>
            {visible.map((template) => (
              <button
                type="button"
                className={selected?.id === template.id ? "selected" : ""}
                role="option"
                aria-selected={selected?.id === template.id}
                onClick={() => {
                  onSelect(template);
                  setOpen(false);
                }}
                key={template.id}
              >
                <span className="project-template-picker-cover">
                  {template.coverUrl ? <img src={template.coverUrl} alt="" /> : <StackSimple size={18} />}
                </span>
                <span>
                  <strong>{template.name}</strong>
                  <small>{template.sourceProjectTitle} · {t("projectTemplates.references", { count: template.referenceCount })}</small>
                </span>
                {selected?.id === template.id ? <Check size={15} weight="bold" /> : null}
              </button>
            ))}
            {!visible.length && templates.length ? <p>{t("projectTemplates.noMatch")}</p> : null}
            {!templates.length ? <p>{t("projectTemplates.emptyPicker")}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

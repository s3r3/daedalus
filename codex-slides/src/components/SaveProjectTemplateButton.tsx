"use client";

import { Check, CircleNotch, StackSimple, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";

export default function SaveProjectTemplateButton({
  projectId,
  projectTitle,
  disabled,
  variant = "toolbar",
  onModalClose,
}: {
  projectId: string;
  projectTitle: string;
  disabled?: boolean;
  variant?: "toolbar" | "menu-item";
  onModalClose?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(projectTitle);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const close = useCallback(() => {
    setOpen(false);
    onModalClose?.();
  }, [onModalClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open, saving]);

  function show() {
    setName(projectTitle);
    setDescription("");
    setSaved(false);
    setError("");
    setOpen(true);
  }

  async function save() {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name: name.trim(), description: description.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t("projectTemplates.saveFailed"));
      setSaved(true);
      window.dispatchEvent(new CustomEvent("codex-slides:templates-changed", { detail: { template: data.template } }));
      window.setTimeout(close, 700);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={variant === "menu-item" ? "pop-item project-actions-menu-item" : "iconbtn project-template-save-trigger"}
        onClick={show}
        disabled={disabled}
        title={t("projectTemplates.saveHelp")}
        role={variant === "menu-item" ? "menuitem" : undefined}
      >
        <StackSimple size={16} />
        {variant === "menu-item" ? (
          <span className="grow">
            <b>{t("projectTemplates.saveButton")}</b>
            <em>{t("projectTemplates.saveHelp")}</em>
          </span>
        ) : <span>{t("projectTemplates.saveButton")}</span>}
      </button>
      {open ? (
        <div className="modal-bg project-template-modal-bg" onMouseDown={(event) => event.target === event.currentTarget && !saving && close()}>
          <div className="project-template-modal" role="dialog" aria-modal="true" aria-labelledby="project-template-modal-title">
            <header>
              <div>
                <span><StackSimple size={18} /></span>
                <div>
                  <h3 id="project-template-modal-title">{t("projectTemplates.saveTitle")}</h3>
                  <p>{t("projectTemplates.saveSubtitle")}</p>
                </div>
              </div>
              <button type="button" onClick={close} disabled={saving} aria-label={t("settings.close")}><X size={17} /></button>
            </header>
            <form className="project-template-modal-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <div className="project-template-modal-body">
                <label>
                  <span>{t("projectTemplates.name")}</span>
                  <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} autoFocus />
                </label>
                <label>
                  <span>{t("projectTemplates.description")}</span>
                  <textarea
                    value={description}
                    maxLength={500}
                    rows={3}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={t("projectTemplates.descriptionPlaceholder")}
                  />
                </label>
                <p className="project-template-modal-note">{t("projectTemplates.savedContents")}</p>
                {error ? <p className="project-template-modal-error" role="alert">{error}</p> : null}
              </div>
              <footer>
                <button type="button" onClick={close} disabled={saving}>{t("common.cancel")}</button>
                <button type="submit" className="primary" disabled={!name.trim() || saving || saved}>
                  {saving ? <CircleNotch className="design-files-spinner" size={15} /> : saved ? <Check size={15} weight="bold" /> : <StackSimple size={15} />}
                  {saving ? t("common.saving") : saved ? t("projectTemplates.saved") : t("projectTemplates.save")}
                </button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

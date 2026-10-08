"use client";

import { Check, StackSimple, Trash } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { ProjectTemplateSummary } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

export default function ProjectTemplates({
  templates,
  selectedId,
  query,
  onUse,
  onDeleted,
}: {
  templates: ProjectTemplateSummary[];
  selectedId?: string;
  query: string;
  onUse: (template: ProjectTemplateSummary) => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useI18n();
  const [deletingId, setDeletingId] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => normalized
    ? templates.filter((template) => (
        `${template.name}\n${template.description}\n${template.sourceProjectTitle}`
          .toLocaleLowerCase()
          .includes(normalized)
      ))
    : templates, [normalized, templates]);

  async function remove(template: ProjectTemplateSummary) {
    if (!window.confirm(t("projectTemplates.deleteConfirm", { name: template.name }))) return;
    setDeletingId(template.id);
    try {
      const response = await fetch(`/api/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("delete failed");
      onDeleted(template.id);
      window.dispatchEvent(new CustomEvent("codex-slides:templates-changed"));
    } catch {
      window.alert(t("projectTemplates.deleteFailed"));
    } finally {
      setDeletingId("");
    }
  }

  if (!templates.length) {
    return (
      <div className="project-template-empty">
        <span><StackSimple size={25} /></span>
        <div>
          <strong>{t("projectTemplates.emptyTitle")}</strong>
          <p>{t("projectTemplates.emptyBody")}</p>
        </div>
      </div>
    );
  }

  if (!visible.length) {
    return <div className="project-template-empty compact"><strong>{t("projectTemplates.noMatch")}</strong></div>;
  }

  return (
    <div className="project-template-grid">
      {visible.map((template) => {
        const selected = selectedId === template.id;
        return (
          <article className={`project-template-card${selected ? " selected" : ""}`} key={template.id}>
            <button type="button" className="project-template-main" onClick={() => onUse(template)}>
              <span className="project-template-cover" style={{ aspectRatio: template.aspect.replace(":", " / ") }}>
                {template.coverUrl ? <img src={template.coverUrl} alt="" /> : <StackSimple size={30} />}
                {selected ? <i><Check size={15} weight="bold" /> {t("projectTemplates.selected")}</i> : null}
              </span>
              <span className="project-template-copy">
                <strong>{template.name}</strong>
                <small>{t("projectTemplates.fromProject", { name: template.sourceProjectTitle })}</small>
                <em>{template.aspect} · {t("projectTemplates.references", { count: template.referenceCount })}</em>
              </span>
            </button>
            <div className="project-template-actions">
              <button type="button" className="primary" onClick={() => onUse(template)}>
                {selected ? t("projectTemplates.inUse") : t("projectTemplates.use")}
              </button>
              <button
                type="button"
                className="danger"
                disabled={deletingId === template.id}
                onClick={() => void remove(template)}
                aria-label={t("projectTemplates.deleteNamed", { name: template.name })}
              >
                <Trash size={15} />
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}


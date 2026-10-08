"use client";

import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { useState } from "react";
import ProjectTemplates from "@/components/ProjectTemplates";
import RecentProjects from "@/components/RecentProjects";
import type { ProjectTemplateSummary } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

export default function HomeLibrary({
  templates,
  selectedTemplateId,
  onUseTemplate,
  onDeleteTemplate,
}: {
  templates: ProjectTemplateSummary[];
  selectedTemplateId?: string;
  onUseTemplate: (template: ProjectTemplateSummary) => void;
  onDeleteTemplate: (id: string) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"projects" | "templates">("projects");
  const [query, setQuery] = useState("");

  function chooseTemplate(template: ProjectTemplateSummary) {
    onUseTemplate(template);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <section className="home-library" aria-label={t("library.title")}>
      <div className="home-library-toolbar">
        <div className="home-library-tabs" role="tablist" aria-label={t("library.title")}>
          <button
            type="button"
            id="home-library-projects-tab"
            className={tab === "projects" ? "active" : ""}
            role="tab"
            aria-selected={tab === "projects"}
            aria-controls="home-library-panel"
            onClick={() => { setTab("projects"); setQuery(""); }}
          >
            {t("projects.title")}
          </button>
          <button
            type="button"
            id="home-library-templates-tab"
            className={tab === "templates" ? "active" : ""}
            role="tab"
            aria-selected={tab === "templates"}
            aria-controls="home-library-panel"
            onClick={() => { setTab("templates"); setQuery(""); }}
          >
            {t("projectTemplates.title")}
            {templates.length ? <span>{templates.length}</span> : null}
          </button>
        </div>
        <label className="home-library-search">
          <MagnifyingGlass size={15} />
          <input
            type="search"
            aria-label={tab === "projects" ? t("library.searchProjects") : t("projectTemplates.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === "projects" ? t("library.searchProjects") : t("projectTemplates.search")}
          />
          {query ? <button type="button" onClick={() => setQuery("")} aria-label={t("library.clearSearch")}><X size={13} /></button> : null}
        </label>
      </div>
      <div
        className="home-library-content"
        id="home-library-panel"
        role="tabpanel"
        aria-labelledby={tab === "projects" ? "home-library-projects-tab" : "home-library-templates-tab"}
      >
        {tab === "projects" ? (
          <RecentProjects embedded query={query} />
        ) : (
          <ProjectTemplates
            templates={templates}
            selectedId={selectedTemplateId}
            query={query}
            onUse={chooseTemplate}
            onDeleted={onDeleteTemplate}
          />
        )}
      </div>
    </section>
  );
}

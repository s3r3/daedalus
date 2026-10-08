"use client";

import Link from "next/link";
import { useEffect, useState, type MouseEvent } from "react";
import ProjectLoadingShell from "@/components/ProjectLoadingShell";
import { useI18n } from "@/i18n/I18nProvider";
import { translate, type UiLocale } from "@/i18n/messages";
import type { ProjectRunState } from "@/lib/types";

interface ProjectSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  aspect: string;
  total: number;
  rendered: number;
  cover: string | null;
  workflowStage?: "clarify" | "research" | "outlining" | "outline" | "inspire" | "rendering" | "deck";
  activeRun?: ProjectRunState;
}

function relativeTime(value: string, locale: UiLocale) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return translate(locale, "time.justNow");
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return translate(locale, "time.justNow");
  if (minutes < 60) return translate(locale, "time.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate(locale, "time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return translate(locale, "time.daysAgo", { count: days });
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(value));
}

const FALLBACK_PREVIEW_TONE_COUNT = 6;

/** Keep unfinished project covers recognizable and stable across refreshes. */
function fallbackPreviewTone(project: Pick<ProjectSummary, "id" | "title">) {
  let hash = 2_166_136_261;
  for (const character of `${project.id}:${project.title}`) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619);
  }
  return (hash >>> 0) % FALLBACK_PREVIEW_TONE_COUNT;
}

function fallbackPreviewInitial(title: string) {
  const firstWordCharacter = Array.from(title.trim()).find((character) => /[\p{L}\p{N}]/u.test(character));
  return (firstWordCharacter ?? "C").toLocaleUpperCase();
}

/** Persisted decks on disk, surfaced as first-class projects on the launcher. */
export default function RecentProjects({ embedded = false, query = "" }: { embedded?: boolean; query?: string }) {
  const { locale, t } = useI18n();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const openingProject = projects.find((project) => project.id === openingId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProjects = normalizedQuery
    ? projects.filter((project) => project.title.toLocaleLowerCase().includes(normalizedQuery))
    : projects;

  function progressLabel(project: ProjectSummary) {
    if (project.activeRun) return project.activeRun.detail || project.activeRun.label;
    switch (project.workflowStage) {
      case "clarify": return t("projects.stageClarify");
      case "research": return t("projects.stageResearch");
      case "outlining": return t("projects.stageOutlining");
      case "outline": return t("projects.stageOutline");
      case "inspire": return t("projects.stageInspire");
      case "rendering": return t("projects.stageRendering", { rendered: project.rendered, total: project.total });
      default: return t("projects.slides", { rendered: project.rendered, total: project.total });
    }
  }

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      fetch("/api/projects", { cache: "no-store", signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Unable to load projects"))))
        .then((data) => {
          if (!disposed) setProjects(data.projects ?? []);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!disposed) setProjects([]);
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, 2500);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <section
      className={`project-section${embedded ? " embedded" : ""}`}
      aria-labelledby={embedded ? undefined : "projects-heading"}
      aria-label={embedded ? t("projects.title") : undefined}
    >
      {!embedded ? <div className="section-head">
        <div>
          <h2 id="projects-heading">{t("projects.title")}</h2>
          <p>{t("projects.subtitle")}</p>
        </div>
        {!loading && projects.length > 0 && (
          <span className="section-count">
            {t(projects.length === 1 ? "projects.countOne" : "projects.countMany", { count: projects.length })}
          </span>
        )}
      </div> : null}

      {loading ? (
        <div className="project-grid" aria-label={t("projects.loading")}>
          {[0, 1, 2].map((item) => (
            <div className="project-card project-skeleton" key={item}>
              <div className="project-cover skeleton" />
              <div className="project-copy">
                <span className="skeleton" />
                <small className="skeleton" />
              </div>
            </div>
          ))}
        </div>
      ) : visibleProjects.length ? (
        <div className="project-grid" aria-busy={Boolean(openingId)}>
          {visibleProjects.map((project) => {
            const resumeOnHome = project.workflowStage === "clarify"
              || project.workflowStage === "research"
              || project.workflowStage === "outlining";
            // Always cross the dedicated project route. Clarify/outlining
            // projects are redirected server-side to the Home resume entry,
            // which guarantees a fresh mount even though the final pathname is
            // `/`. A same-path `/?resume=…` anchor can update the URL without
            // remounting Home in an already-running App Router session.
            const href = `/project/${encodeURIComponent(project.id)}`;
            const content = <>
              <div className="project-cover" style={{ aspectRatio: project.aspect.replace(":", " / ") }}>
                {project.cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/files/${project.id}/${project.cover}`} alt="" />
                ) : (
                  <span
                    aria-label={t("projects.noPreview")}
                    className="project-empty-cover"
                    data-tone={fallbackPreviewTone(project)}
                    role="img"
                  >
                    <span aria-hidden="true">{fallbackPreviewInitial(project.title)}</span>
                  </span>
                )}
                <span className="project-open" aria-hidden="true">
                  {openingId === project.id ? <span className="project-open-spinner" /> : "↗"}
                </span>
                {project.activeRun ? (
                  <span className="project-run-badge" title={project.activeRun.detail || project.activeRun.label}>
                    <span className="project-open-spinner" aria-hidden="true" />
                    <span>
                      {project.activeRun.status === "stopping"
                        ? t("chat.backgroundStopping")
                        : `${t("chat.backgroundRunning")} · ${project.activeRun.label}`}
                    </span>
                  </span>
                ) : null}
              </div>
              <div className="project-copy">
                <strong>{project.title}</strong>
                <span>
                  {progressLabel(project)}
                  <i aria-hidden="true" />
                  {relativeTime(project.updatedAt ?? project.createdAt, locale)}
                </span>
              </div>
            </>;
            const className = `project-card${openingId === project.id ? " is-opening" : ""}${project.activeRun ? " is-running" : ""}`;
            const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              setOpeningId(project.id);
            };
            return resumeOnHome ? (
              <a
                className={className}
                href={href}
                key={project.id}
                onClick={onClick}
                aria-label={t("projects.open", { title: project.title })}
              >
                {content}
              </a>
            ) : (
              <Link
                className={className}
                href={href}
                key={project.id}
                onClick={onClick}
                aria-label={t("projects.open", { title: project.title })}
              >
                {content}
              </Link>
            );
          })}
        </div>
      ) : projects.length && normalizedQuery ? (
        <div className="project-empty compact">
          <span className="project-empty-icon">⌕</span>
          <div><strong>{t("projects.noSearchResults")}</strong></div>
        </div>
      ) : (
        <div className="project-empty">
          <span className="project-empty-icon">▤</span>
          <div>
            <strong>{t("projects.emptyTitle")}</strong>
            <p>{t("projects.emptyBody")}</p>
          </div>
        </div>
      )}
      {openingProject && (
        <div className="project-opening-overlay">
          <ProjectLoadingShell title={openingProject.title} />
        </div>
      )}
    </section>
  );
}

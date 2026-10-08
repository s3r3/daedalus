import { useUiPreferences } from '../contexts/useUiPreferences'
import type { ProjectSummary } from '../types'

interface ProjectLibraryProps {
  projects: ProjectSummary[]
  activeProjectId: string | null
  isLoading: boolean
  onOpenProject: (id: string) => void | Promise<void>
  onNewProject: () => void | Promise<void>
  onRenameProject: (id: string, title: string) => void | Promise<void>
  onDuplicateProject: (id: string) => void | Promise<void>
  onDeleteProject: (id: string) => void | Promise<void>
}

function formatUpdatedAt(timestamp: number, language: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function ProjectIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v11a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 17.5v-11zM8 8h8M8 12h8M8 16h5"
      />
    </svg>
  )
}

function ProjectLibrary({
  projects,
  activeProjectId,
  isLoading,
  onOpenProject,
  onNewProject,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject
}: ProjectLibraryProps) {
  const { language, t } = useUiPreferences()

  const handleRename = (project: ProjectSummary) => {
    const nextTitle = window.prompt(t('projects.renamePrompt'), project.title)
    if (!nextTitle?.trim() || nextTitle.trim() === project.title) {
      return
    }

    void onRenameProject(project.id, nextTitle.trim())
  }

  const handleDelete = (project: ProjectSummary) => {
    if (!window.confirm(t('projects.deleteConfirm'))) {
      return
    }

    void onDeleteProject(project.id)
  }

  return (
    <section className="mt-5 min-h-0 border-t border-[var(--border)] pt-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--text-strong)]">{t('projects.title')}</h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{t('projects.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void onNewProject()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-warm-200 bg-white px-2.5 py-1.5 text-xs font-medium text-warm-700 shadow-sm transition-colors hover:bg-warm-50 focus:outline-none focus:ring-2 focus:ring-warm-300"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
          </svg>
          {t('projects.new')}
        </button>
      </div>

      {isLoading && (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-white/55 px-3 py-3 text-xs text-[var(--text-muted)]">
          {t('slide.loading')}
        </div>
      )}

      {!isLoading && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-white/55 px-3 py-3 text-xs text-[var(--text-muted)]">
          {t('projects.empty')}
        </div>
      )}

      {!isLoading && projects.length > 0 && (
        <div className="space-y-2">
          {projects.map((project) => {
            const isActive = project.id === activeProjectId

            return (
              <div
                key={project.id}
                className={`rounded-lg border bg-white/80 p-2.5 shadow-sm transition-colors ${
                  isActive ? 'border-warm-300 ring-1 ring-warm-200' : 'border-[var(--border)] hover:border-warm-200'
                }`}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => void onOpenProject(project.id)}
                    className="min-w-0 flex-1 text-left focus:outline-none focus:ring-2 focus:ring-warm-300 rounded-md"
                    aria-label={t('projects.openProject', { title: project.title })}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-warm-50 text-warm-600">
                        <ProjectIcon />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[var(--text-strong)]">
                          {project.title}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
                          {project.fileName || t('projects.noFile')}
                        </span>
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 pl-9 text-xs text-[var(--text-muted)]">
                      <span>{t('projects.slideCount', { count: project.slideCount })}</span>
                      <span>{t('projects.updatedAt', { date: formatUpdatedAt(project.updatedAt, language) })}</span>
                      {isActive && (
                        <span className="rounded-full bg-warm-100 px-2 py-0.5 text-[11px] font-medium text-warm-700">
                          {t('projects.active')}
                        </span>
                      )}
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleRename(project)}
                      className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-warm-50 hover:text-warm-700 focus:outline-none focus:ring-2 focus:ring-warm-300"
                      aria-label={`${t('projects.rename')} ${project.title}`}
                      title={t('projects.rename')}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L9 17.652 5.25 18.75 6.348 15 16.862 4.487z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDuplicateProject(project.id)}
                      className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-warm-50 hover:text-warm-700 focus:outline-none focus:ring-2 focus:ring-warm-300"
                      aria-label={`${t('projects.duplicate')} ${project.title}`}
                      title={t('projects.duplicate')}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 8h10v10H8zM6 16H5a2 2 0 01-2-2V5a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(project)}
                      className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-200"
                      aria-label={`${t('projects.delete')} ${project.title}`}
                      title={t('projects.delete')}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v12a2 2 0 01-2 2H9a2 2 0 01-2-2V7" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default ProjectLibrary

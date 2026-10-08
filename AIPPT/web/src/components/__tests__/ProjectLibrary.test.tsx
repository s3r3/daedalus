import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectLibrary from '../ProjectLibrary'
import { UiPreferencesProvider } from '../../contexts/UiPreferencesContext'
import type { ProjectSummary } from '../../types'

const projects: ProjectSummary[] = [
  {
    id: 'project-1',
    title: 'Launch Plan',
    fileName: 'launch.md',
    slideCount: 8,
    status: 'generated',
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 0, 2),
    lastOpenedAt: Date.UTC(2026, 0, 3)
  },
  {
    id: 'project-2',
    title: 'Research Notes',
    fileName: '',
    slideCount: 0,
    status: 'draft',
    createdAt: Date.UTC(2026, 1, 1),
    updatedAt: Date.UTC(2026, 1, 2),
    lastOpenedAt: Date.UTC(2026, 1, 3)
  }
]

function renderLibrary(overrides: Partial<Parameters<typeof ProjectLibrary>[0]> = {}) {
  const props = {
    projects,
    activeProjectId: 'project-1',
    isLoading: false,
    onOpenProject: vi.fn(),
    onNewProject: vi.fn(),
    onRenameProject: vi.fn(),
    onDuplicateProject: vi.fn(),
    onDeleteProject: vi.fn(),
    ...overrides
  }

  render(
    <UiPreferencesProvider>
      <ProjectLibrary {...props} />
    </UiPreferencesProvider>
  )

  return props
}

describe('ProjectLibrary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('displays saved projects with title, slide count, active marker, and updated date', () => {
    renderLibrary()

    expect(screen.getByText('Launch Plan')).toBeInTheDocument()
    expect(screen.getByText('Research Notes')).toBeInTheDocument()
    expect(screen.getByText('8 张幻灯片')).toBeInTheDocument()
    expect(screen.getByText('0 张幻灯片')).toBeInTheDocument()
    expect(screen.getByText('当前')).toBeInTheDocument()
    expect(screen.getAllByText(/更新于/)).toHaveLength(2)
  })

  it('opens a saved project when the project row is clicked', () => {
    const { onOpenProject } = renderLibrary()

    fireEvent.click(screen.getByRole('button', { name: /打开 Launch Plan/ }))

    expect(onOpenProject).toHaveBeenCalledWith('project-1')
  })

  it('starts a new project from the library action', () => {
    const { onNewProject } = renderLibrary()

    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))

    expect(onNewProject).toHaveBeenCalledTimes(1)
  })

  it('exposes rename, duplicate, and delete actions for each project', () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Plan')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onRenameProject, onDuplicateProject, onDeleteProject } = renderLibrary()

    fireEvent.click(screen.getByRole('button', { name: '重命名 Launch Plan' }))
    fireEvent.click(screen.getByRole('button', { name: '复制 Launch Plan' }))
    fireEvent.click(screen.getByRole('button', { name: '删除 Launch Plan' }))

    expect(promptSpy).toHaveBeenCalledWith('输入新的项目名称', 'Launch Plan')
    expect(confirmSpy).toHaveBeenCalledWith('确定删除这个项目吗？')
    expect(onRenameProject).toHaveBeenCalledWith('project-1', 'Renamed Plan')
    expect(onDuplicateProject).toHaveBeenCalledWith('project-1')
    expect(onDeleteProject).toHaveBeenCalledWith('project-1')
  })
})

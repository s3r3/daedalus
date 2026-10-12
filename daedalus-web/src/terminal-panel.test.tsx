import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TerminalPane } from './components/terminal/terminal-pane'
import { useDaedalusStore } from './state/taskStore'
import { TERMINAL_HEIGHT, TERMINAL_HEIGHT_KEY } from './state/prefs'

beforeEach(() => {
  localStorage.clear()
  useDaedalusStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

const panelHeight = (): string => (screen.getByTestId('terminal-panel') as HTMLElement).style.height

/** jsdom's PointerEvent carries no clientY; a MouseEvent with the pointer type does. */
const pointer = (type: string, clientY: number): MouseEvent => new MouseEvent(type, { bubbles: true, clientY })

describe('TerminalPane resize', () => {
  test('starts at the persisted default height', () => {
    render(<TerminalPane />)
    expect(screen.getByTestId('terminal-resize-handle').getAttribute('aria-valuenow')).toBe(String(TERMINAL_HEIGHT.default))
    expect(panelHeight()).toBe(`${TERMINAL_HEIGHT.default}px`)
  })

  test('dragging the top handle up grows the pane and persists on release', () => {
    render(<TerminalPane />)
    const handle = screen.getByTestId('terminal-resize-handle')
    fireEvent(handle, pointer('pointerdown', 300))
    fireEvent(window, pointer('pointermove', 240))
    expect(panelHeight()).toBe(`${TERMINAL_HEIGHT.default + 60}px`)
    fireEvent(window, pointer('pointerup', 240))
    expect(localStorage.getItem(TERMINAL_HEIGHT_KEY)).toBe(String(TERMINAL_HEIGHT.default + 60))
  })

  test('dragging is clamped at the maximum height', () => {
    render(<TerminalPane />)
    const handle = screen.getByTestId('terminal-resize-handle')
    fireEvent(handle, pointer('pointerdown', 900))
    fireEvent(window, pointer('pointermove', -500))
    expect(panelHeight()).toBe(`${TERMINAL_HEIGHT.max}px`)
    fireEvent(window, pointer('pointerup', -500))
    expect(localStorage.getItem(TERMINAL_HEIGHT_KEY)).toBe(String(TERMINAL_HEIGHT.max))
  })

  test('double-click resets to the default height', () => {
    localStorage.setItem(TERMINAL_HEIGHT_KEY, '400')
    render(<TerminalPane />)
    expect(panelHeight()).toBe('400px')
    fireEvent.doubleClick(screen.getByTestId('terminal-resize-handle'))
    expect(panelHeight()).toBe(`${TERMINAL_HEIGHT.default}px`)
    expect(localStorage.getItem(TERMINAL_HEIGHT_KEY)).toBe(String(TERMINAL_HEIGHT.default))
  })

  test('arrow keys resize and persist', () => {
    render(<TerminalPane />)
    const handle = screen.getByTestId('terminal-resize-handle')
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(panelHeight()).toBe(`${TERMINAL_HEIGHT.default + 16}px`)
    expect(localStorage.getItem(TERMINAL_HEIGHT_KEY)).toBe(String(TERMINAL_HEIGHT.default + 16))
    fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true })
    expect(panelHeight()).toBe(`${TERMINAL_HEIGHT.default + 16 - 48}px`)
  })
})

import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Keeps one failing panel (e.g. a heavy lazy surface) from blanking the app. */
export class PanelErrorBoundary extends Component<{ fallback?: ReactNode; onError?: (error: Error) => void; children?: ReactNode }, { failed: boolean }> {
  constructor(props: { fallback?: ReactNode; onError?: (error: Error) => void; children?: ReactNode }) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error)
    if (info.componentStack === undefined && this.props.onError === undefined) return
  }

  override render(): ReactNode {
    if (this.state.failed) return this.props.fallback ?? null
    return this.props.children ?? null
  }
}
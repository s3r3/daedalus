/** File-extension → Monaco language id mapping for the editor surface. */
const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
}

export function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGES[extension] ?? 'plaintext'
}

/**
 * Model URI for Monaco. The TypeScript service picks its script kind from
 * the model path's extension (.tsx → TSX, .jsx → JSX); an anonymous
 * in-memory model has no extension, so Monaco parsed every React file as
 * plain TS/JS and flagged (or misread) the JSX — the editor "detected
 * JSX" in .tsx files (Farid's report). Carrying the workspace path in the
 * URI keeps the real extension in front of the language service.
 */
export function modelUriForPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  return `inmemory://workspace/${normalized}`
}
export type StudioMode = 'dev' | 'web' | 'pdf';

export function getMode(): StudioMode {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('print')) {
    return 'pdf';
  }
  if (import.meta.env.DEV) {
    return 'dev';
  }
  return 'web';
}

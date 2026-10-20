/**
 * Package version, surfaced by `daedalus --version` and by the web shell.
 * Standalone so the browser can import it without pulling in the core barrel,
 * which reaches `node:fs`.
 */
export const VERSION = "0.1.0";

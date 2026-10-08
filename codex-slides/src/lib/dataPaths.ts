import path from "node:path";

/**
 * Browser development keeps data inside the checkout. Packaged Electron builds
 * point CODEX_SLIDES_DATA_DIR at app.getPath("userData") so projects, templates,
 * and staged files remain writable and survive application upgrades.
 */
export const DATA_ROOT = process.env.CODEX_SLIDES_DATA_DIR
  ? path.resolve(process.env.CODEX_SLIDES_DATA_DIR)
  : path.join(process.cwd(), "data");


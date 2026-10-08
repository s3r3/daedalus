// Zero-config Codex credentials.
//
// The premise of codex-slides: if you can run `codex`, you can generate a deck —
// no API key, no .env. We reuse the ChatGPT OAuth access token the Codex CLI
// already stored after `codex login`.
//
// Stored at $CODEX_HOME/auth.json (default ~/.codex/auth.json):
//   { "tokens": { "access_token": "...", ... }, ... }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class CodexAuthError extends Error {}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function authPath(): string {
  return path.join(codexHome(), "auth.json");
}

/** Read the ChatGPT OAuth access token the Codex CLI stored on disk. */
export function getCodexAccessToken(): string {
  const override =
    process.env.CODEX_SLIDES_CODEX_TOKEN || process.env.CODEX_ACCESS_TOKEN;
  if (override) return override.trim();

  const p = authPath();
  if (!fs.existsSync(p)) {
    throw new CodexAuthError(
      `No Codex credentials at ${p}.\nRun \`codex login\` (choose "Sign in with ChatGPT") first.`,
    );
  }
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e: any) {
    throw new CodexAuthError(`Could not read ${p}: ${e?.message ?? e}`);
  }
  const token = data?.tokens?.access_token;
  if (!token) {
    throw new CodexAuthError(
      `${p} has no tokens.access_token.\n` +
        "You are likely logged into Codex with an API key rather than a ChatGPT\n" +
        'account. Re-run `codex login` and choose "Sign in with ChatGPT".',
    );
  }
  return String(token).trim();
}

export function hasCodexToken(): boolean {
  try {
    getCodexAccessToken();
    return true;
  } catch {
    return false;
  }
}

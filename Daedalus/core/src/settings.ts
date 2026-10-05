export type Settings = {
  llm: { baseUrl: string; apiKey: string; model: string; timeoutMs: number | null };
  server: { host: string; port: number };
  daedalusHome: string;
};

export type Env = Record<string, string | undefined>;

/**
 * Typed settings loader. Secrets come from environment only and are never logged
 * (PLAN.md §10). Missing values fall back to safe defaults where possible.
 */
export function loadSettings(env: Env = process.env): Settings {
  const port = Number(env.DAEDALUS_PORT ?? "3080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid DAEDALUS_PORT: ${String(env.DAEDALUS_PORT)}`);
  }
  return {
    llm: {
      baseUrl: env.LLM_BASE_URL ?? "https://llm.ayid.cc.cd/v1",
      apiKey: env.LLM_API_KEY ?? "",
      model: env.LLM_MODEL ?? "",
      timeoutMs: positiveInt(env.LLM_TIMEOUT_MS),
    },
    server: {
      host: env.DAEDALUS_HOST ?? "127.0.0.1",
      port,
    },
    daedalusHome: env.DAEDALUS_HOME ?? ".daedalus",
  };
}

/** `null` means "unset" — the provider then applies its own default timeout. */
function positiveInt(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid LLM_TIMEOUT_MS: ${value} (expected a positive integer number of milliseconds)`);
  }
  return parsed;
}

/** Redacted view of settings safe to log or expose over the API. */
export function redactSettings(settings: Settings): Record<string, unknown> {
  return {
    ...settings,
    llm: {
      ...settings.llm,
      apiKey: settings.llm.apiKey ? "«redacted»" : "",
    },
  };
}

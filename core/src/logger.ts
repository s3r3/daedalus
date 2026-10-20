export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = ReturnType<typeof createLogger>;

/**
 * Structured logging: one JSON object per line with level, msg, request_id,
 * task_id, and arbitrary fields. Secrets must never be passed in `fields`.
 */
export function createLogger(
  options: {
    level?: LogLevel;
    base?: Record<string, unknown>;
    write?: (line: string) => void;
    now?: () => Date;
  } = {},
): {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
  child: (fields: Record<string, unknown>) => ReturnType<typeof createLogger>;
} {
  const threshold = LEVELS[options.level ?? "info"];
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < threshold) return;
    write(
      JSON.stringify({
        ts: now().toISOString(),
        level,
        msg,
        ...base,
        ...fields,
      }),
    );
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

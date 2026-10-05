import { Command } from "commander";
import { createInterface } from "node:readline";
import {
  TaskRunner,
  TaskStore,
  exitCodeFor,
  loadSettings,
  createProviderFromSettings,
  VERSION,
  bold,
  dim,
  fg,
  palette,
  type Event,
  type Message,
  type PermissionKey,
} from "@daedalus/core";

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPINNER_INTERVAL_MS = 50;

/**
 * Generate a cycling gradient for the spinner (Crush-inspired)
 * Simulates Crush's working gradient animation in CLI.
 */
function cyclingGradient(char: string, frame: number, palette: typeof import("@daedalus/core").palette): string {
  if (!supportsColor()) return char;
  const [r1, g1, b1] = rgb(palette.workingFrom);
  const [r2, g2, b2] = rgb(palette.workingTo);
  const t = (frame % 20) / 20; // 20-frame cycle
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `\x1b[38;2;${r};${g};${b}m${char}\x1b[0m`;
}

function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return Boolean((process.stdout as { isTTY?: boolean }).isTTY);
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '');
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Wrap `s` in a hue foreground; falls back to plain text when color is disabled. */
const paint = (hex: string, s: string): string => {
  const f = fg(hex);
  return f.length === 0 ? s : `${f}${s}\x1b[0m`;
};

/**
 * SIGINT handler for a running task: cancel it, then exit with the conventional
 * 128 + SIGINT(2) code so scripts can distinguish a user abort from a failure.
 * Extracted so it can be asserted without spawning a real signal.
 */
export function makeSigintHandler(
  runner: { cancel: (taskId: string) => void },
  getTaskId: () => string | undefined,
  shouldReport: () => boolean,
): () => void {
  return () => {
    const taskId = getTaskId();
    if (taskId) {
      runner.cancel(taskId);
      if (shouldReport()) process.stderr.write(`\n${paint(palette.error, "Task cancelled by user (SIGINT).")}\n`);
    }
    process.exit(130);
  };
}

/** Parse a positive-integer CLI flag. Returns undefined when unset. */
export function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer number of milliseconds, received "${value}"`);
  }
  return parsed;
}

/** Map a raw approval answer to a broker decision. Fails closed on anything unrecognised. */
export function parseApproval(answer: string): { decision: "grant" | "deny"; remember: boolean } {
  const a = answer.trim().toLowerCase();
  if (a.startsWith("r")) return { decision: "grant", remember: true };
  if (a.startsWith("a")) return { decision: "grant", remember: false };
  return { decision: "deny", remember: false };
}

export function formatEvent(event: Omit<Event, "seq" | "ts">): string {
  switch (event.type) {
    case "TASK_STARTED": {
      const p = event.payload as { spec?: { goal?: string } };
      return `${paint(palette.primary, "●")} ${bold("Task:")} ${p.spec?.goal ?? ""}\n`;
    }
    case "PLAN_CREATED": {
      const p = event.payload as { plan?: { steps?: Array<{ intent: string }> } };
      const steps = p.plan?.steps ?? [];
      return `${paint(palette.secondary, "✦")} Plan (${steps.length} steps):\n${steps.map((s, i) => `  ${i + 1}. ${s.intent}`).join("\n")}\n`;
    }
    case "TOOL_CALL_STARTED": {
      const p = event.payload as { call?: { tool: string; args: unknown } };
      return `  ${paint(palette.warning, "⠋")} ${dim(p.call?.tool ?? "")} ${JSON.stringify(p.call?.args ?? {})}\n`;
    }
    case "TOOL_CALL_FINISHED": {
      const p = event.payload as { call?: { tool: string }; result?: { status: string; output: string } };
      const ok = p.result?.status === "ok";
      const icon = ok ? paint(palette.success, "✔") : paint(palette.error, "✖");
      const snippet = (p.result?.output ?? "").trim().slice(0, 80);
      return `  ${icon} ${dim(`${p.call?.tool} -> ${snippet}`)}\n`;
    }
    case "VALIDATION_STARTED": {
      return `${paint(palette.info, "◆")} Running validation checks...\n`;
    }
    case "VALIDATION_PASSED": {
      return `${paint(palette.success, "✔")} Validation passed!\n`;
    }
    case "VALIDATION_FAILED": {
      const p = event.payload as { result?: { checks?: Array<{ name: string; status: string }> } };
      const fails = p.result?.checks?.filter((c) => c.status !== "pass") ?? [];
      return `${paint(palette.error, "✖")} Validation failed (${fails.map((f) => f.name).join(", ")})\n`;
    }
    case "RECOVERY_STARTED": {
      const p = event.payload as { reason?: string; strategy?: string; attempt?: number };
      return `${paint(palette.warning, "↻")} Recovery: ${p.strategy} (attempt ${p.attempt}) — ${p.reason}\n`;
    }
    case "APPROVAL_REQUESTED": {
      const p = event.payload as { key?: { tool: string; action: string; path?: string } };
      return `${paint(palette.warning, "▲")} Approval requested: ${p.key?.tool} [${p.key?.action}] ${p.key?.path ?? ""}\n`;
    }
    case "TASK_COMPLETED": {
      const p = event.payload as { outcome?: string; reason?: string };
      const icon = p.outcome === "success"
        ? paint(palette.success, "✔")
        : paint(palette.error, "✖");
      return `\n${icon} ${bold(`Task ${p.outcome}: ${p.reason}`)}\n`;
    }
    default:
      return "";
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("daedalus")
    .description("Daedalus — a web-based agentic coding framework powered by large language models")
    .version(VERSION, "-v, --version", "print the Daedalus version");

  program
    .command("health")
    .description("check that the Daedalus core is importable and report configuration")
    .option("--url <url>", "server base URL override")
    .action(async (options: { url?: string }) => {
      const settings = loadSettings();
      const base = options.url ?? `http://${settings.server.host}:${settings.server.port}`;
      try {
        const res = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(3000) });
        const body = (await res.json()) as unknown;
        process.stdout.write(JSON.stringify({ core: "ok", server: body }, null, 2) + "\n");
      } catch (error) {
        process.stderr.write(`core ok, server unreachable at ${base}: ${String(error)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("run")
    .description("execute a task autonomously through Daedalus Core")
    .argument("<task>", "natural language software engineering goal")
    .option("--cwd <path>", "target workspace directory", process.cwd())
    .option("--json", "emit JSON events and final report", false)
    .option("--yolo", "auto-approve all mutating tool actions", false)
    .option("--max-iterations <number>", "max agent loop iterations", "25")
    .option("--model <name>", "override the model from settings (LLM_MODEL)")
    .option("--provider <name>", "override the provider endpoint (LLM_BASE_URL)")
    .option("--timeout <ms>", "per-request model timeout in milliseconds (LLM_TIMEOUT_MS)")
    .option("--verbose", "also stream the raw JSON event line for every event", false)
    .action(async (
      task: string,
      options: { cwd: string; json?: boolean; yolo?: boolean; maxIterations?: string; model?: string; provider?: string; timeout?: string; verbose?: boolean },
    ) => {
      const workspaceRoot = options.cwd;
      const approvalPolicy = options.yolo ? "auto" : "ask";
      const maxIterations = parseInt(options.maxIterations ?? "25", 10);
      const tty = process.stdout.isTTY && !options.json;

      const modelTimeoutMs = parsePositiveInt(options.timeout, "--timeout");

      const settings = loadSettings();
      if (options.model !== undefined || options.provider !== undefined) {
        settings.llm.model = options.model ?? settings.llm.model;
        settings.llm.baseUrl = options.provider ?? settings.llm.baseUrl;
      }

      const runner = new TaskRunner({
        workspaceRoot,
        approvalPolicy,
        maxIterations,
        settings,
        ...(modelTimeoutMs === undefined ? {} : { modelTimeoutMs }),
      });

      let currentTaskId: string | undefined;
      let stopSpinner: (() => void) | undefined;
      let rl: ReturnType<typeof createInterface> | undefined;

      const promptApproval = async (key: PermissionKey): Promise<void> => {
        rl ??= createInterface({ input: process.stdin });
        const answer = await new Promise<string>((resolve) => rl!.question(
          `${paint(palette.warning, "▲ Approval requested: ")} ${bold(key.tool)} ${dim(`[${key.action}] ${key.path ?? ""}`)}\n  approve (a) / deny (d) / remember (r)? `,
          resolve,
        ));
        const { decision, remember } = parseApproval(answer);
        runner.approvals.decide(key, decision, remember);
      };

      const startSpinner = (label: string): void => {
        if (!tty || stopSpinner) return;
        let frame = 0;
        const tick = () => {
          const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
          const colored = supportsColor()
            ? cyclingGradient(glyph, frame, palette)
            : glyph;
          process.stdout.write(`\r${colored} ${dim(label)}`);
          frame++;
        };
        tick();
        const timer = setInterval(tick, SPINNER_INTERVAL_MS);
        stopSpinner = () => {
          clearInterval(timer);
          stopSpinner = undefined;
          process.stdout.write("\r\x1b[2K");
        };
      };

      const sigintHandler = makeSigintHandler(runner, () => currentTaskId, () => !options.json);
      process.on("SIGINT", sigintHandler);

      try {
        const result = await runner.run({
          goal: task,
          onEvent: (event: Event) => {
            currentTaskId = event.task_id;
            // --verbose adds the raw event line alongside the human-readable
            // rendering; --json remains the exclusive machine-readable mode.
            if (options.verbose) process.stderr.write(JSON.stringify(event) + "\n");
            if (options.json) {
              process.stdout.write(JSON.stringify(event) + "\n");
            } else if (tty) {
              if (event.type === "APPROVAL_REQUESTED") {
                stopSpinner?.();
                stopSpinner = undefined;
                const key = (event.payload as { key?: PermissionKey }).key;
                if (key) void promptApproval(key);
              } else {
                stopSpinner?.();
                stopSpinner = undefined;
                const formatted = formatEvent(event);
                if (formatted) process.stdout.write(formatted);
                if (event.type === "MODEL_REQUEST_STARTED") startSpinner("thinking...");
                if (event.type === "TOOL_CALL_STARTED") startSpinner("working...");
              }
            } else {
              const formatted = formatEvent(event);
              if (formatted) process.stdout.write(formatted);
            }
          },
        });

        stopSpinner?.();
        stopSpinner = undefined;

        if (options.json) {
          process.stdout.write(JSON.stringify({ report: result.report, outcome: result.outcome }) + "\n");
        }

        const code = exitCodeFor(result.outcome);
        process.exitCode = code;
      } catch (error) {
        stopSpinner?.();
        stopSpinner = undefined;
        if (options.json) {
          process.stdout.write(JSON.stringify({ error: String(error) }) + "\n");
        } else {
          process.stderr.write(`${paint(palette.error, `Error: ${String(error)}`)}\n`);
        }
        process.exitCode = 1;
      } finally {
        stopSpinner?.();
        process.removeListener("SIGINT", sigintHandler);
        rl?.close();
      }
    });

  program
    .command("cancel")
    .description("request cancellation of an active task by its id")
    .argument("<task-id>", "id of the task to cancel")
    .action((taskId: string) => {
      const settings = loadSettings();
      const store = new TaskStore(settings.daedalusHome);
      store.requestCancel(taskId);
      process.stdout.write(`Cancellation requested for task ${taskId}\n`);
    });

  program
    .command("ask")
    .description("send a prompt to the configured LLM provider (gated by DAEDALUS_LIVE_LLM=1)")
    .argument("<prompt>", "message to send")
    .action((prompt: string) => {
      if (process.env.DAEDALUS_LIVE_LLM !== "1") {
        process.stderr.write("DAEDALUS_LIVE_LLM=1 is required to send live prompts; set it and retry\n");
        process.exitCode = 1;
        return;
      }
      const settings = loadSettings();
      if (!settings.llm.model) {
        process.stderr.write("LLM_MODEL is required\n");
        process.exitCode = 1;
        return;
      }
      const provider = createProviderFromSettings(settings);
      const messages: Message[] = [{ role: "user", content: prompt }];
      provider
        .chat(messages)
        .then((res) => {
          process.stdout.write(`${res.message.content}\n`);
        })
        .catch((error: unknown) => {
          process.stderr.write(String(error) + "\n");
          process.exitCode = 1;
        });
    });

  return program;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1] ?? ""}` ||
  (process.argv[1] ?? "").endsWith("/daedalus") ||
  (process.argv[1] ?? "").endsWith("cli/src/index.ts");

if (invokedDirectly) {
  buildProgram().parseAsync(process.argv).catch((error: unknown) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
}

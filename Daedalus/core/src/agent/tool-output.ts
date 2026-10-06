import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Tool-output shaping (the Crush/OpenCode harness pattern): a single step
 * that bounds what a tool result may put into the model's context while
 * keeping the complete text recoverable.
 *
 * Every tool result passes through here (in the agent loop, just before the
 * observation is built) instead of each tool inventing its own head-only
 * slice. Head-only truncation loses exactly the part of a long output that
 * matters most — test summaries and error tails live at the end — which
 * taught models to re-run the same command hoping for a different view and
 * fuelled runaway loops. So over-cap output keeps its head AND tail, and the
 * full text is written to a per-task spill file the model can page back with
 * `read_file` (offset/limit). The event log keeps the executor's untouched
 * result; only the model-facing copy is shortened.
 */

/** Char budget for one tool result in model context (~50KB, the Crush/OpenCode ballpark). */
export const TOOL_OUTPUT_MAX_CHARS = 50_000;
/** Line budget for one tool result in model context (~2,000 lines, the Crush/OpenCode ballpark). */
export const TOOL_OUTPUT_MAX_LINES = 2_000;
/** Fraction of the kept budget spent on the head; the tail gets the remainder. */
export const TOOL_OUTPUT_HEAD_RATIO = 0.6;

export type ToolOutputLimits = {
  maxChars: number;
  maxLines: number;
  /** Write full over-cap outputs to a spill file (needs a `spillPathFor` sink). */
  spill: boolean;
};

export const DEFAULT_TOOL_OUTPUT_LIMITS: ToolOutputLimits = {
  maxChars: TOOL_OUTPUT_MAX_CHARS,
  maxLines: TOOL_OUTPUT_MAX_LINES,
  spill: true,
};

export type ShapedToolOutput = {
  /** Model-facing text: the original when under the caps, else head + tail + truncation marker. */
  output: string;
  truncated: boolean;
  /** Path of the spill file holding the exact full output, when one was written. */
  spillPath?: string;
  totalChars: number;
  totalLines: number;
  /** Content lines (or line parts) kept in `output`, excluding the marker line. */
  shownLines: number;
};

export type ShapeToolOutputOptions = {
  /** Tool name, used for the spill filename and diagnostics. */
  tool: string;
  limits?: Partial<ToolOutputLimits>;
  /**
   * Mint the spill-file path for this tool. Called only when the output is
   * over a cap and spill is enabled; the returned path is created (with
   * parent directories) and filled with the exact full output. Failures are
   * swallowed — shaping never fails a tool call over a spill problem.
   */
  spillPathFor?: (tool: string) => string;
};

/** Fill defaults and reject degenerate limits (non-positive / non-finite fall back). */
export function resolveToolOutputLimits(partial?: Partial<ToolOutputLimits>): ToolOutputLimits {
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return {
    maxChars: positive(partial?.maxChars, TOOL_OUTPUT_MAX_CHARS),
    maxLines: positive(partial?.maxLines, TOOL_OUTPUT_MAX_LINES),
    spill: partial?.spill !== false,
  };
}

/**
 * Shape one tool result for the model. Under either cap the text passes
 * through untouched and nothing is spilled; over a cap it is truncated
 * head+tail and (when enabled and a sink is given) the full text is spilled.
 */
export async function shapeToolOutput(output: string, options: ShapeToolOutputOptions): Promise<ShapedToolOutput> {
  const limits = resolveToolOutputLimits(options.limits);
  const totalChars = output.length;
  const totalLines = countLines(output);
  if (totalChars <= limits.maxChars && totalLines <= limits.maxLines) {
    return { output, truncated: false, totalChars, totalLines, shownLines: totalLines };
  }
  const { text, shownLines } = truncateHeadTail(output, limits.maxChars, limits.maxLines);
  let spillPath: string | undefined;
  if (limits.spill && options.spillPathFor) {
    try {
      const candidate = options.spillPathFor(options.tool);
      await mkdir(dirname(candidate), { recursive: true });
      await writeFile(candidate, output, "utf8");
      spillPath = candidate;
    } catch {
      // Fail-open: a spill failure degrades the marker, never the tool call.
      spillPath = undefined;
    }
  }
  const marker = spillPath
    ? `[output truncated: showed ${shownLines} of ${totalLines} lines / ${totalChars} chars — full output saved to ${spillPath}; read it with read_file using offset/limit if you need the middle]`
    : `[output truncated: showed ${shownLines} of ${totalLines} lines / ${totalChars} chars — full output not saved (spill disabled or unavailable)]`;
  return {
    output: `${text}\n${marker}`,
    truncated: true,
    ...(spillPath ? { spillPath } : {}),
    totalChars,
    totalLines,
    shownLines,
  };
}

/**
 * Keep the first ~60% and last ~40% of the allowed budget. The line cap is
 * applied first (whole lines), then the char cap cuts what remains, snapping
 * to line boundaries whenever the kept text spans multiple lines so line
 * numbers in `read_file`-style output stay meaningful.
 */
export function truncateHeadTail(text: string, maxChars: number, maxLines: number): { text: string; shownLines: number } {
  const lines = text.split("\n");
  let kept = lines;
  if (lines.length > maxLines) {
    const headCount = Math.max(1, Math.floor(maxLines * TOOL_OUTPUT_HEAD_RATIO));
    const tailCount = Math.max(0, maxLines - headCount);
    kept = [...lines.slice(0, headCount), ...(tailCount > 0 ? lines.slice(lines.length - tailCount) : [])];
  }
  let shown = kept.join("\n");
  if (shown.length > maxChars) {
    const headBudget = Math.max(1, Math.floor(maxChars * TOOL_OUTPUT_HEAD_RATIO));
    const tailBudget = Math.max(0, maxChars - headBudget);
    let head = shown.slice(0, headBudget);
    const headCut = head.lastIndexOf("\n");
    const headSnapped = headCut > 0;
    if (headSnapped) head = head.slice(0, headCut);
    let tail = tailBudget > 0 ? shown.slice(shown.length - tailBudget) : "";
    const tailCut = tail.indexOf("\n");
    if (tailCut >= 0 && tailCut < tail.length - 1) tail = tail.slice(tailCut + 1);
    shown = tail ? (headSnapped ? `${head}\n${tail}` : `${head}${tail}`) : head;
  }
  return { text: shown, shownLines: shown.length === 0 ? 0 : shown.split("\n").length };
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

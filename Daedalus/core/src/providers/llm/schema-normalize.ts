import type { ToolDefinition } from "./types.ts";

/**
 * Bedrock/Anthropic-safe tool-schema normalization.
 *
 * Claude on Bedrock rejects a request whose tool `input_schema` carries
 * `oneOf`/`allOf`/`anyOf` at the top level of ANY tool (HTTP 400,
 * TOOL_SCHEMA_INVALID) — one offending tool poisons the whole request, so
 * every model call fails before the model ever runs. Daedalus tool schemas
 * legitimately use a top-level `anyOf` (e.g. read_file's "path OR paths"),
 * and the runtime validator (agent/tool-call-validation.ts) enforces that
 * semantics against the DECLARED schema. This module rewrites only the
 * wire copy sent to providers: combinators are flattened away, branch
 * `properties` are merged into the parent, and the surviving `required`
 * set is the fields every branch requires anyway (plus any already
 * required at the parent level). The declared schemas in the tool
 * registry are never mutated, so dispatch-time validation is unchanged.
 */

const COMBINATORS = ["oneOf", "allOf", "anyOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFields(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === "string") : [];
}

/** Recursively flatten oneOf/allOf/anyOf out of a JSON-schema value. Pure: builds new objects, never mutates the input. */
function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeSchema(entry));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((COMBINATORS as readonly string[]).includes(key)) continue;
    out[key] = normalizeSchema(entry);
  }

  const branchLists = COMBINATORS
    .map((key) => value[key])
    .filter((list): list is unknown[] => Array.isArray(list));
  if (branchLists.length === 0) return out;

  const branches = branchLists.flat().map((branch) => normalizeSchema(branch)).filter(isRecord);
  if (branches.length === 0) return out;

  // Branch properties become available parameters; the parent's own
  // property definitions win on a name clash (they are the author's
  // explicit top-level declaration).
  const mergedProperties: Record<string, unknown> = {};
  for (const branch of branches) {
    if (isRecord(branch.properties)) Object.assign(mergedProperties, branch.properties);
  }
  if (isRecord(out.properties)) Object.assign(mergedProperties, out.properties);
  if (Object.keys(mergedProperties).length > 0) out.properties = mergedProperties;

  // A field is still model-facing-required only when every combinator
  // branch requires it (any satisfied choice guarantees its presence) —
  // or when the parent already required it outside the combinator. The
  // choice itself ("path OR paths") stays enforced by the runtime
  // validator against the declared schema, not by this wire copy.
  const branchRequired = branches.map((branch) => stringFields(branch.required));
  const common = branchRequired.length > 0
    ? branchRequired.reduce((acc, fields) => acc.filter((f) => fields.includes(f)))
    : [];
  const required = [...new Set([...stringFields(value.required), ...common])];
  if (required.length > 0) out.required = required;
  else delete out.required;

  return out;
}

/** Normalize one tool's `parameters` schema for the wire; `undefined` and non-object schemas pass through untouched. */
export function normalizeToolParameters(
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!isRecord(parameters)) return parameters;
  return normalizeSchema(parameters) as Record<string, unknown>;
}

/** Normalize every tool definition's parameters, returning fresh tool objects (inputs are not mutated). */
export function normalizeToolSchemas(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    function: { ...tool.function, parameters: normalizeToolParameters(tool.function.parameters) },
  }));
}

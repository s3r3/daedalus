/**
 * Tool-call argument validation against the tool's declared JSON schema,
 * run before dispatch (and therefore before the call can poison history).
 *
 * Motivation, from the incident reports: a router translating between
 * OpenAI and Anthropic tool formats merged `start_line`/`end_line` into
 * one corrupted string ("3,10...") in ~7% of read_file calls; the calls
 * "succeeded" with wrong ranges and the corruption persisted into
 * history (9Router issue #2868). Harnx's parser silently substituted
 * `{}` for malformed streamed args; tools then ran argument-less and
 * the model retried identically. Both are loop generators. The rule
 * here: a call whose arguments do not match the schema is NEVER
 * executed and NEVER silently repaired — it returns a typed parse-error
 * observation naming the tool, the field, the expected type, and what
 * arrived, so the model's next sample differs.
 */

export type ToolCallValidation =
  | { ok: true }
  | { ok: false; field?: string; reason: string };

type JsonSchemaObject = {
  type?: unknown;
  properties?: Record<string, { type?: unknown } | undefined>;
  required?: unknown;
  anyOf?: unknown;
};

function receivedKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return true; // undeclared/free-form types are not policed
  }
}

/**
 * Validate `args` against a tool's input schema (JSON-Schema subset:
 * `required` + per-property `type`). Extra properties are NOT policed —
 * models routinely send harmless extras; corruption shows up as a
 * missing required field or a wrong-typed one (a string where an
 * integer belongs), and those are what this catches.
 */
export function validateToolCallArguments(
  toolName: string,
  schema: unknown,
  args: unknown,
): ToolCallValidation {
  if (!schema || typeof schema !== 'object') return { ok: true };
  const shape = schema as JsonSchemaObject;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, reason: `tool ${toolName} arguments must be a JSON object, got ${receivedKind(args)}` };
  }
  const record = args as Record<string, unknown>;
  const required = Array.isArray(shape.required) ? shape.required.filter((f): f is string => typeof f === 'string') : [];
  for (const field of required) {
    if (record[field] === undefined) {
      return { ok: false, field, reason: `tool ${toolName} is missing required parameter <${field}>` };
    }
  }
  // anyOf alternatives of required-groups ("path OR paths"): at least
  // one alternative must be fully present. This keeps the gate honest
  // for tools whose shape is a choice between parameter sets instead of
  // letting an empty call fall through to a handler error.
  if (Array.isArray(shape.anyOf)) {
    const alternatives = shape.anyOf
      .map((alt) => (alt && typeof alt === 'object' && Array.isArray((alt as JsonSchemaObject).required) ? ((alt as JsonSchemaObject).required as unknown[]).filter((f): f is string => typeof f === 'string') : []))
      .filter((fields) => fields.length > 0);
    if (alternatives.length > 0 && !alternatives.some((fields) => fields.every((field) => record[field] !== undefined))) {
      const names = alternatives.map((fields) => fields.join(' + ')).join(' OR ');
      return { ok: false, field: alternatives[0]?.[0], reason: `tool ${toolName} is missing required parameters: provide ${names}` };
    }
  }
  const properties = shape.properties ?? {};
  for (const [field, propSchema] of Object.entries(properties)) {
    const value = record[field];
    if (value === undefined) continue;
    const type = typeof propSchema?.type === 'string' ? propSchema.type : undefined;
    if (!type) continue;
    if (!matchesType(value, type)) {
      const shown = typeof value === 'string' ? `string "${value.slice(0, 60)}"` : receivedKind(value);
      return { ok: false, field, reason: `parameter <${field}> of ${toolName} must be a ${type}, got ${shown}` };
    }
  }
  return { ok: true };
}

/** Short schema summary for the parse-error observation (required + typed fields). */
export function schemaSummary(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '';
  const shape = schema as JsonSchemaObject;
  const required = new Set(Array.isArray(shape.required) ? shape.required.filter((f): f is string => typeof f === 'string') : []);
  const parts = Object.entries(shape.properties ?? {}).map(([field, propSchema]) => {
    const type = typeof propSchema?.type === 'string' ? propSchema.type : 'any';
    return `${field} (${type}${required.has(field) ? ', required' : ''})`;
  });
  return parts.join(', ');
}

/** The model-facing parse-error observation: typed, specific, never a substitution. */
export function toolCallParseErrorOutput(toolName: string, validation: Extract<ToolCallValidation, { ok: false }>, schema: unknown): string {
  const summary = schemaSummary(schema);
  return [
    `tool_call parse error: ${validation.reason}.`,
    'The call was NOT executed and no arguments were substituted.',
    `Re-issue ${toolName} with arguments matching its schema${summary ? ` (${summary})` : ''} — check each value\'s type (a number must be a JSON number, not a string).`,
  ].join(' ');
}

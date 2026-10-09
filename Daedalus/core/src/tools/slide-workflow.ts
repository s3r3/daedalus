import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildHybridSlideDraft } from '../slides/hybrid-generator';
import type { ToolDefinition } from './registry';

function ok(output: string, meta: Record<string, unknown> = {}): { call_id: string; status: 'ok'; output: string; truncated: false; meta: Record<string, unknown> } {
  return { call_id: '', status: 'ok', output, truncated: false, meta };
}

function err(output: string, meta: Record<string, unknown> = {}): { call_id: string; status: 'error'; output: string; truncated: false; meta: Record<string, unknown> } {
  return { call_id: '', status: 'error', output, truncated: false, meta };
}

function safeResolveWorkspace(root: string, relativeOrAbsolute: string): string {
  const candidate = resolve(root, relativeOrAbsolute);
  if (!candidate.startsWith(resolve(root))) {
    throw new Error('path escapes workspace root');
  }
  return candidate;
}

export const generateSlideOutlineTool: ToolDefinition = {
  name: 'generate_slide_outline',
  description: 'Generate a hybrid presentation outline using Presenton validation rules and AIPPT-style structure.',
  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string' },
      n_slides: { type: 'integer', minimum: 1, maximum: 12 },
      language: { type: 'string' },
      tone: { type: 'string' },
      style: { type: 'string' },
    },
    additionalProperties: false,
  },
  mutating: false,
  async execute(args, context) {
    const a = args as { topic?: unknown; n_slides?: unknown; language?: unknown; tone?: unknown; style?: unknown };
    if (typeof a.topic !== 'string' || a.topic.trim().length === 0) {
      return err('topic must be a non-empty string');
    }
    const draft = buildHybridSlideDraft(a.topic.trim(), Number(a.n_slides ?? 8));
    const issues = draft.issues.length > 0 ? `\nIssues:\n${draft.issues.map((line) => `- ${line}`).join('\n')}` : '\nIssues: none';
    return ok(`Outline generated: ${draft.outline.length} slides for "${a.topic.trim()}".${issues}`, {
      slide_count: draft.outline.length,
      issues: draft.issues,
      prompt_count: draft.prompts.length,
    });
  },
};

export const generateSlidePromptsTool: ToolDefinition = {
  name: 'generate_slide_prompts',
  description: 'Generate per-slide prompts from the hybrid outline so the slide draft is ready to export.',
  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string' },
      n_slides: { type: 'integer', minimum: 1, maximum: 12 },
    },
    additionalProperties: false,
  },
  mutating: false,
  async execute(args) {
    const a = args as { topic?: unknown; n_slides?: unknown };
    if (typeof a.topic !== 'string' || a.topic.trim().length === 0) {
      return err('topic must be a non-empty string');
    }
    const draft = buildHybridSlideDraft(a.topic.trim(), Number(a.n_slides ?? 8));
    return ok(`Per-slide prompts generated for ${draft.prompts.length} slides.`, {
      slide_count: draft.prompts.length,
      prompts: draft.prompts,
    });
  },
};

export const saveSlideMarkdownTool: ToolDefinition = {
  name: 'save_slide_markdown',
  description: 'Save the hybrid slide markdown to a safe path inside the workspace.',
  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string' },
      n_slides: { type: 'integer', minimum: 1, maximum: 12 },
      output_dir: { type: 'string' },
      file_name: { type: 'string' },
    },
    additionalProperties: false,
  },
  mutating: true,
  async execute(args, context) {
    const a = args as { topic?: unknown; n_slides?: unknown; output_dir?: unknown; file_name?: unknown };
    if (typeof a.topic !== 'string' || a.topic.trim().length === 0) {
      return err('topic must be a non-empty string');
    }
    const root = context.workspaceRoot;
    const outDir = typeof a.output_dir === 'string' && a.output_dir.trim().length > 0 ? a.output_dir.trim() : 'slides';
    const fileName = typeof a.file_name === 'string' && a.file_name.trim().length > 0 ? a.file_name.trim() : `${a.topic.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'slides'}.md`;
    const safeFile = safeResolveWorkspace(root, join(outDir, fileName));
    const safeDir = dirname(safeFile);
    await mkdir(safeDir, { recursive: true });
    const draft = buildHybridSlideDraft(a.topic.trim(), Number(a.n_slides ?? 8));
    await writeFile(safeFile, draft.markdown, 'utf8');
    return ok(`Saved ${draft.outline.length} slide draft to ${safeFile.replace(root + '/', '')}.`, {
      path: safeFile.replace(root + '/', ''),
      slide_count: draft.outline.length,
      issues: draft.issues,
    });
  },
};

export const validateSlideOutputTool: ToolDefinition = {
  name: 'validate_slide_output',
  description: 'Validate that the generated slide deck has the expected count and acceptable content length.',
  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string' },
      n_slides: { type: 'integer', minimum: 1, maximum: 12 },
      output_dir: { type: 'string' },
    },
    additionalProperties: false,
  },
  mutating: false,
  async execute(args, context) {
    const a = args as { topic?: unknown; n_slides?: unknown; output_dir?: unknown };
    if (typeof a.topic !== 'string' || a.topic.trim().length === 0) {
      return err('topic must be a non-empty string');
    }
    const nSlides = Number(a.n_slides ?? 8);
    const outDir = typeof a.output_dir === 'string' && a.output_dir.trim().length > 0 ? a.output_dir.trim() : 'slides';
    const dir = safeResolveWorkspace(context.workspaceRoot, outDir);
    let entries: string[] = [];
    try {
      entries = (await readdir(dir)).filter((entry) => entry.endsWith('.md'));
    } catch {
      return err(`No slide markdown directory found at ${outDir}.`);
    }
    if (entries.length < nSlides) {
      return err(`Expected at least ${nSlides} markdown slide files in ${outDir}, found ${entries.length}.`);
    }
    const contentChecks = [] as string[];
    for (const entry of entries.slice(0, nSlides)) {
      const filePath = join(dir, entry);
      const text = await readFile(filePath, 'utf8');
      if (text.trim().length < 100) {
        contentChecks.push(`${entry} is too short (${text.trim().length} chars)`);
      }
    }
    if (contentChecks.length > 0) {
      return err(`Validation failed: ${contentChecks.join('; ')}`);
    }
    return ok(`Validation passed: ${Math.min(entries.length, nSlides)} slide files found and content length is acceptable.`, {
      files_found: entries.length,
      expected: nSlides,
    });
  },
};

export const SLIDE_WORKFLOW_TOOLS: ToolDefinition[] = [
  generateSlideOutlineTool,
  generateSlidePromptsTool,
  saveSlideMarkdownTool,
  validateSlideOutputTool,
];

import { readFile, stat } from 'node:fs/promises';
import type { ToolDefinition } from '../registry.ts';
import type { ToolResult } from '../../contracts.ts';
import { pathInWorkspace } from '../filesystem/index.ts';

/**
 * view_image: let the model actually LOOK at an image in the workspace
 * (Claude Code's image-capable Read / Codex's view_image). The tool result
 * text is a one-line placeholder; the image bytes ride in
 * `meta.image_data_url`, which the agent loop lifts onto the next model
 * request as an `image_url` content block (the same carriage user
 * uploads take) and strips before the result is emitted or persisted —
 * so transcripts and the event log never carry base64.
 *
 * Vision gate: the tool refuses when the execution context says the
 * selected model cannot see images (`visionEnabled === false`, resolved
 * by the runtime from the provider registry's supportsVision flags).
 * Silently dropping the picture would teach the model it "saw" something
 * it never received — the refusal names the fix instead.
 */

/** Mirrors the context manager's attachment cap (5 MB per image). */
export const VIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Magic-byte sniff: the real format decides, never the file name. */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

export const viewImageTool: ToolDefinition = {
  name: 'view_image',
  description: [
    'Look at an image file in the workspace (png, jpg/jpeg, gif, webp; up to 5 MB): the picture is attached to the conversation and you see it on your next turn.',
    'Use it to inspect screenshots, mockups, or generated images instead of guessing from file names. The selected model must support vision — with a text-only model this call refuses and says so (never pretends you saw it).',
  ].join(' '),
  mutating: false,
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string', description: 'Workspace-relative path of the image, e.g. screenshots/home.png' } },
    additionalProperties: false,
  },
  async execute(args, context): Promise<ToolResult> {
    const path = (args as { path?: unknown })?.path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { call_id: '', status: 'error', output: 'view_image requires a string "path".', truncated: false, meta: { reason: 'invalid_arguments' } };
    }
    if (context.visionEnabled === false) {
      return {
        call_id: '',
        status: 'denied',
        output: 'current model cannot view images — view_image needs a vision-capable model. Switch the task to a model with vision support (the model picker marks them), or inspect the image another way.',
        truncated: false,
        meta: { reason: 'vision_unsupported', path },
      };
    }
    let absolute: string;
    try {
      absolute = await pathInWorkspace(context.workspaceRoot, path);
    } catch (error) {
      return { call_id: '', status: 'error', output: String(error), truncated: false, meta: { reason: 'path_escape', path } };
    }
    let bytes: Buffer;
    try {
      const info = await stat(absolute);
      if (!info.isFile()) return { call_id: '', status: 'error', output: `view_image: ${path} is not a file`, truncated: false, meta: { reason: 'not_a_file', path } };
      if (info.size === 0) return { call_id: '', status: 'error', output: `view_image: ${path} is empty`, truncated: false, meta: { reason: 'empty', path } };
      if (info.size > VIEW_IMAGE_MAX_BYTES) {
        return {
          call_id: '',
          status: 'error',
          output: `view_image: ${path} is ${info.size} bytes, over the ${VIEW_IMAGE_MAX_BYTES}-byte limit — downscale or crop the image first.`,
          truncated: false,
          meta: { reason: 'too_large', path, bytes: info.size },
        };
      }
      bytes = await readFile(absolute);
    } catch (error) {
      return { call_id: '', status: 'error', output: String(error), truncated: false, meta: { reason: 'read_failed', path } };
    }
    const mime = sniffImageMime(bytes);
    if (!mime) {
      return {
        call_id: '',
        status: 'error',
        output: `view_image: ${path} is not a supported image (png, jpg/jpeg, gif, webp) — the file's bytes do not match any of those formats.`,
        truncated: false,
        meta: { reason: 'unsupported_image', path },
      };
    }
    return {
      call_id: '',
      status: 'ok',
      output: `viewed image ${path} (${mime}, ${bytes.length} bytes) — the image itself is attached to this conversation; you see it with this result.`,
      truncated: false,
      meta: {
        image_path: path,
        image_mime: mime,
        image_bytes: bytes.length,
        // Lifted by the agent loop onto the next request as an image_url
        // block, then stripped from the result before it is emitted or
        // persisted (transcripts render the placeholder line above).
        image_data_url: `data:${mime};base64,${bytes.toString('base64')}`,
      },
    };
  },
};

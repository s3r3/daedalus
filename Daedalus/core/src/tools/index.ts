export { createDirTool, editFileTool, editSearchReplaceTool, hunkPreview, listDirTool, pathInWorkspace, readFileTool, READ_FILE_MAX_BATCH, writeFileTool, confined, IGNORED_DIRECTORY_NAMES, MAX_LIST_ENTRIES, walkTreeLines } from './filesystem/index.ts';
export { applySearchReplace, parseSearchReplaceBlocks, type AppliedSearchReplace, type ParsedSearchReplace, type SearchReplaceBlock } from './filesystem/search-replace.ts';
export { applyWhitespaceTolerant, findWhitespaceTolerantMatch, reindentReplacement, type TolerantApplied, type TolerantMatch } from './filesystem/text-match.ts';
export { changedLineCounts, diffLines, renderPatch, type DiffLine } from './filesystem/diff.ts';
export {
  SANDBOX_ALLOWLIST,
  BackgroundJobManager,
  JOB_OUTPUT_BUFFER_CHARS,
  JOB_STATUS_DEFAULT_TAIL_CHARS,
  JOB_STATUS_MAX_TAIL_CHARS,
  MAX_BACKGROUND_JOBS_PER_TASK,
  commandKillTool,
  commandStatusTool,
  gitDiffTool,
  gitStatusTool,
  runCommandTool,
  type BackgroundJob,
  type BackgroundJobHooks,
  type BackgroundJobState,
  type StartJobResult,
} from './terminal/index.ts';
export { globTool, grepTool } from './search/index.ts';
export {
  createFetchUrlTool,
  fetchUrlTool,
  FETCH_URL_MAX_BODY_CHARS,
  FETCH_URL_MAX_CHARS,
  FETCH_URL_MAX_REDIRECTS,
  FETCH_URL_TIMEOUT_MS,
  capFetchedText,
  decodeHtmlEntities,
  htmlToText,
  isBlockedFetchHost,
  validateFetchTarget,
  type FetchUrlImpl,
  type FetchUrlResponse,
} from './web/index.ts';
export { viewImageTool, VIEW_IMAGE_MAX_BYTES, sniffImageMime } from './media/index.ts';
export {
  createDownloadFileTool,
  createSearchImagesTool,
  downloadFileTool,
  searchImagesTool,
  DOWNLOAD_FILE_DEFAULT_MAX_BYTES,
  DOWNLOAD_FILE_MAX_REDIRECTS,
  DOWNLOAD_FILE_TIMEOUT_MS,
  IMAGE_TOOLS_USER_AGENT,
  SEARCH_IMAGES_DEFAULT_COUNT,
  SEARCH_IMAGES_MAX_COUNT,
  SEARCH_IMAGES_TIMEOUT_MS,
  buildOpenverseQueryUrl,
  buildWikimediaQueryUrl,
  imageDimensions,
  mergeImageResults,
  parseOpenverseResults,
  parseWikimediaResults,
  type DownloadFetchImpl,
  type DownloadFetchResponse,
  type ImageSearchResult,
  type ImageSearchFetchImpl,
} from './images/index.ts';
export { ToolRegistry, MAX_TOOL_CALL_TIMEOUT_MS, clampCallTimeoutMs, type ToolDefinition, type ModelToolSchema, type ToolExecutionContext } from './registry.ts';

import { createDirTool, editFileTool, listDirTool, readFileTool, writeFileTool } from './filesystem/index.ts';
import { commandKillTool, commandStatusTool, gitDiffTool, gitStatusTool, runCommandTool } from './terminal/index.ts';
import { globTool, grepTool } from './search/index.ts';
import { fetchUrlTool } from './web/index.ts';
import { viewImageTool } from './media/index.ts';
import { downloadFileTool, searchImagesTool } from './images/index.ts';
import { ToolRegistry, type ToolDefinition } from './registry.ts';

export const DEFAULT_TOOLS: ToolDefinition[] = [readFileTool, writeFileTool, editFileTool, createDirTool, listDirTool, grepTool, globTool, runCommandTool, commandStatusTool, commandKillTool, gitDiffTool, gitStatusTool, fetchUrlTool, viewImageTool, searchImagesTool, downloadFileTool];

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of DEFAULT_TOOLS) registry.register(tool);
  return registry;
}

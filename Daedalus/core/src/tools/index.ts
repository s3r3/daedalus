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
  JOB_TEARDOWN_DRAIN_MS,
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
export { createGrepTool, globTool, grepTool, parseRipgrepJson, ripgrepArgs, type GrepOutputMode } from './search/index.ts';
export {
  createFetchUrlTool,
  fetchUrlTool,
  createWebSearchTool,
  webSearchTool,
  parseDuckDuckGoHtml,
  webSearchBackend,
  FETCH_URL_MAX_BODY_CHARS,
  FETCH_URL_MAX_CHARS,
  FETCH_URL_MAX_REDIRECTS,
  FETCH_URL_TIMEOUT_MS,
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_SEARCH_MAX_COUNT,
  WEB_SEARCH_MAX_QUERIES,
  WEB_SEARCH_TIMEOUT_MS,
  capFetchedText,
  decodeHtmlEntities,
  htmlToText,
  isBlockedFetchHost,
  validateFetchTarget,
  type FetchUrlImpl,
  type FetchUrlResponse,
  type WebSearchBackend,
  type WebSearchFetchImpl,
  type WebSearchResult,
} from './web/index.ts';
export { createScreenshotTool, screenshotTool, resolveScreenshotBrowser, screenshotChromeArgs, SCREENSHOT_DEFAULT_HEIGHT, SCREENSHOT_DEFAULT_WIDTH, SCREENSHOT_TIMEOUT_MS, viewImageTool, VIEW_IMAGE_MAX_BYTES, sniffImageMime, type ScreenshotRunner } from './media/index.ts';
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

export { createDeckTool, readDeckTool, addSlideTool, updateSlideTool, moveSlideTool, deleteSlideTool, setDeckThemeTool, validateDeckTool, exportDeckTool, SLIDE_TOOLS } from './slides.ts';

import { createDirTool, editFileTool, listDirTool, readFileTool, writeFileTool } from './filesystem/index.ts';
import { commandKillTool, commandStatusTool, gitDiffTool, gitStatusTool, runCommandTool } from './terminal/index.ts';
import { globTool, grepTool } from './search/index.ts';
import { fetchUrlTool, webSearchTool } from './web/index.ts';
import { screenshotTool, viewImageTool } from './media/index.ts';
import { downloadFileTool, searchImagesTool } from './images/index.ts';
import { ToolRegistry, type ToolDefinition } from './registry.ts';

/**
 * The CODING tool surface — the default registry every coding run gets.
 * The nine slide (deck) tools are deliberately NOT here: slide tasks run
 * on the SlideEngine with exactly SLIDE_TOOLS (see tools/slides.ts, which
 * likewise carries no coding tools), and the extra ~3.7k tokens of slide
 * schemas per model call is dead weight on every coding turn.
 */
export const DEFAULT_TOOLS: ToolDefinition[] = [readFileTool, writeFileTool, editFileTool, createDirTool, listDirTool, grepTool, globTool, runCommandTool, commandStatusTool, commandKillTool, gitDiffTool, gitStatusTool, fetchUrlTool, webSearchTool, viewImageTool, screenshotTool, searchImagesTool, downloadFileTool];

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of DEFAULT_TOOLS) registry.register(tool);
  return registry;
}

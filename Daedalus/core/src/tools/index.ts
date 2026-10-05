export { editFileTool, listDirTool, pathInWorkspace, readFileTool, writeFileTool, confined } from './filesystem/index.ts';
export { changedLineCounts, diffLines, renderPatch, type DiffLine } from './filesystem/diff.ts';
export { gitDiffTool, gitStatusTool, runCommandTool } from './terminal/index.ts';
export { globTool, grepTool } from './search/index.ts';
export { ToolRegistry, type ToolDefinition, type ModelToolSchema, type ToolExecutionContext } from './registry.ts';

import { editFileTool, listDirTool, readFileTool, writeFileTool } from './filesystem/index.ts';
import { gitDiffTool, gitStatusTool, runCommandTool } from './terminal/index.ts';
import { globTool, grepTool } from './search/index.ts';
import { ToolRegistry, type ToolDefinition } from './registry.ts';

export const DEFAULT_TOOLS: ToolDefinition[] = [readFileTool, writeFileTool, editFileTool, listDirTool, grepTool, globTool, runCommandTool, gitDiffTool, gitStatusTool];

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of DEFAULT_TOOLS) registry.register(tool);
  return registry;
}

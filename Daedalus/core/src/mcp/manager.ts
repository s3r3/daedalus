import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '../tools/registry.ts';
import type { ToolResult } from '../contracts.ts';
import { McpClient, isPlainObject, sanitizeToolSegment, type McpRemoteTool, type McpServerConfig } from './client.ts';

export type { McpServerConfig } from './client.ts';

export type McpServerStatus = {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
};

export const MCP_CONFIG_RELATIVE_PATH = '.daedalus/mcp.json';

/**
 * Load MCP server definitions from `<workspace>/.daedalus/mcp.json`:
 * `{ "servers": [{ "name", "command", "args"?, "env"?, "timeoutMs"? }] }`.
 * A missing or malformed file yields an empty list plus a human-readable
 * problem string instead of throwing, so a broken config never bricks a run.
 */
export async function loadMcpConfig(workspaceRoot: string): Promise<{ servers: McpServerConfig[]; problems: string[] }> {
  const path = join(workspaceRoot, MCP_CONFIG_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { servers: [], problems: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { servers: [], problems: [`${MCP_CONFIG_RELATIVE_PATH}: invalid JSON (${(error as Error).message})`] };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.servers)) {
    return { servers: [], problems: [`${MCP_CONFIG_RELATIVE_PATH}: expected an object with a "servers" array`] };
  }
  const servers: McpServerConfig[] = [];
  const problems: string[] = [];
  for (const [index, entry] of parsed.servers.entries()) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || typeof entry.command !== 'string' || !entry.name || !entry.command) {
      problems.push(`${MCP_CONFIG_RELATIVE_PATH}: servers[${index}] needs string "name" and "command"`);
      continue;
    }
    servers.push({
      name: entry.name,
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
      env: isPlainObject(entry.env)
        ? Object.fromEntries(Object.entries(entry.env).filter(([, v]) => typeof v === 'string') as Array<[string, string]>)
        : undefined,
      timeoutMs: typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0 ? entry.timeoutMs : undefined,
    });
  }
  return { servers, problems };
}

const MAX_TOOL_OUTPUT = 16_000;

/**
 * Owns every configured MCP server connection for one run. Servers connect in
 * parallel; a server that fails to start is recorded in `status()` and simply
 * contributes no tools — the task itself never fails because of it.
 */
export class McpManager {
  readonly #configs: McpServerConfig[];
  readonly #entries = new Map<string, { client: McpClient; tools: McpRemoteTool[] }>();
  readonly #statuses = new Map<string, McpServerStatus>();

  constructor(servers: McpServerConfig[] = []) {
    this.#configs = servers;
    for (const server of servers) {
      this.#statuses.set(server.name, { name: server.name, connected: false, toolCount: 0 });
    }
  }

  get configuredServers(): McpServerConfig[] {
    return [...this.#configs];
  }

  status(): McpServerStatus[] {
    return this.#configs.map((server) => this.#statuses.get(server.name) ?? { name: server.name, connected: false, toolCount: 0 });
  }

  async connectAll(): Promise<McpServerStatus[]> {
    await Promise.all(this.#configs.map(async (config) => {
      const client = new McpClient(config);
      try {
        await client.connect();
        const tools = await client.listTools();
        this.#entries.set(config.name, { client, tools });
        this.#statuses.set(config.name, { name: config.name, connected: true, toolCount: tools.length });
      } catch (error) {
        this.#statuses.set(config.name, { name: config.name, connected: false, toolCount: 0, error: (error as Error).message });
        await client.close().catch(() => undefined);
      }
    }));
    return this.status();
  }

  /** Bridge every connected remote tool into a core ToolDefinition. */
  tools(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const config of this.#configs) {
      const entry = this.#entries.get(config.name);
      if (!entry) continue;
      for (const remote of entry.tools) {
        definitions.push(this.#wrapTool(config.name, entry.client, remote));
      }
    }
    return definitions;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => entry.client.close().catch(() => undefined)));
    this.#entries.clear();
    for (const status of this.#statuses.values()) status.connected = false;
  }

  #wrapTool(serverName: string, client: McpClient, remote: McpRemoteTool): ToolDefinition {
    const name = `mcp__${sanitizeToolSegment(serverName)}__${sanitizeToolSegment(remote.name)}`;
    return {
      name,
      description: remote.description ? `[MCP ${serverName}] ${remote.description}` : `[MCP ${serverName}] MCP tool ${remote.name}.`,
      inputSchema: remote.inputSchema,
      mutating: true,
      async execute(args): Promise<ToolResult> {
        try {
          const outcome = await client.callTool(remote.name, args);
          const output = outcome.text.length > MAX_TOOL_OUTPUT
            ? `${outcome.text.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated]`
            : outcome.text;
          return {
            call_id: '',
            status: outcome.isError ? 'error' : 'ok',
            output: output || (outcome.isError ? `MCP tool ${remote.name} reported an error with no message.` : '(no output)'),
            truncated: outcome.text.length > MAX_TOOL_OUTPUT,
            meta: { mcp_server: serverName, mcp_tool: remote.name },
          };
        } catch (error) {
          return {
            call_id: '',
            status: 'error',
            output: `MCP tool call failed (${serverName}/${remote.name}): ${(error as Error).message}`,
            truncated: false,
            meta: { mcp_server: serverName, mcp_tool: remote.name },
          };
        }
      },
    };
  }
}

import type { AgentMode, ProviderConfigPublic, SlashCommand } from '../contracts.ts';
import { AGENT_MODES } from '../contracts.ts';

export type SlashCommandResult = { text: string; action?: string; data?: unknown };
export type ParsedSlashCommand = { name: string; args: string[]; raw: string };

export type SlashCommandContext = {
  getMode: () => AgentMode;
  setMode: (mode: AgentMode) => Promise<SlashCommandResult> | SlashCommandResult;
  cycleMode?: () => Promise<SlashCommandResult> | SlashCommandResult;
  getAutoApprove: () => boolean;
  setAutoApprove: (value: boolean) => Promise<SlashCommandResult> | SlashCommandResult;
  listModels: () => Promise<Array<{ providerId: string; model: string }>> | Array<{ providerId: string; model: string }>;
  listProviders: () => Promise<ProviderConfigPublic[]> | ProviderConfigPublic[];
  getCurrentModel: () => { providerId?: string; model?: string } | undefined;
  setModel: (selection: string) => Promise<SlashCommandResult> | SlashCommandResult;
  testProvider?: (id?: string) => Promise<SlashCommandResult> | SlashCommandResult;
  getSettings: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  setSetting?: (key: string, value: string) => Promise<SlashCommandResult> | SlashCommandResult;
  getPlan: () => Promise<string> | string;
  getWorkspace: () => Promise<string> | string;
  listFiles: () => Promise<string> | string;
  getDiff: () => Promise<string> | string;
  validate: () => Promise<string> | string;
  upload: (args: string[]) => Promise<SlashCommandResult> | SlashCommandResult;
  image: (args: string[]) => Promise<SlashCommandResult> | SlashCommandResult;
  newTask?: () => Promise<SlashCommandResult> | SlashCommandResult;
  clear?: () => Promise<SlashCommandResult> | SlashCommandResult;
  status: () => Promise<string> | string;
  cancel?: () => Promise<SlashCommandResult> | SlashCommandResult;
  exit?: () => Promise<SlashCommandResult> | SlashCommandResult;
  getMcpStatus?: () => Promise<string> | string;
  listSkills?: () => Promise<string> | string;
  listAgents?: () => Promise<string> | string;
  review?: () => Promise<SlashCommandResult> | SlashCommandResult;
  getLspStatus?: () => Promise<string> | string;
  rewind?: () => Promise<SlashCommandResult> | SlashCommandResult;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show command help', usage: '/help [command]' },
  { name: 'mode', description: 'Show or switch agent mode', usage: '/mode [ask|manual|auto|code|plan]' },
  { name: 'models', description: 'List or switch models', usage: '/models [provider/model]' },
  { name: 'providers', description: 'List providers or test one', usage: '/providers [add|test <id>]' },
  { name: 'settings', description: 'Show or update settings', usage: '/settings [key value]' },
  { name: 'auto-approve', description: 'Toggle auto-approve', usage: '/auto-approve [on|off]', mutating: true },
  { name: 'plan', description: 'Show the current plan', usage: '/plan' },
  { name: 'workspace', description: 'Show workspace information', usage: '/workspace' },
  { name: 'files', description: 'List workspace files', usage: '/files' },
  { name: 'upload', description: 'Upload a file, folder, or ZIP', usage: '/upload <path>', mutating: true },
  { name: 'image', description: 'Attach an image', usage: '/image <path>', mutating: true },
  { name: 'diff', description: 'Show the current diff', usage: '/diff' },
  { name: 'validate', description: 'Run validation', usage: '/validate' },
  { name: 'rewind', description: "Rewind the last task's file changes from its checkpoints", usage: '/rewind', mutating: true },
  { name: 'new', description: 'Start a new task', usage: '/new' },
  { name: 'clear', description: 'Clear the current conversation view', usage: '/clear' },
  { name: 'status', description: 'Show task and session status', usage: '/status' },
  { name: 'cancel', description: 'Cancel the running task', usage: '/cancel' },
  { name: 'mcp', description: 'Show MCP server status', usage: '/mcp' },
  { name: 'skills', description: 'List available skills', usage: '/skills' },
  { name: 'agents', description: 'List defined subagents', usage: '/agents' },
  { name: 'review', description: 'Run a read-only review of the current diff', usage: '/review' },
  { name: 'lsp', description: 'Show language server status', usage: '/lsp' },
  { name: 'exit', description: 'Close this interface', usage: '/exit' },
];

export function parseSlashCommand(input: string): ParsedSlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (!head) return { name: '', args: [], raw: input };
  return { name: head.toLowerCase(), args: rest, raw: input };
}

export function slashCommandSuggestions(prefix: string): SlashCommand[] {
  const normalized = prefix.replace(/^\//, '').toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(normalized) || (command.aliases ?? []).some((alias) => alias.startsWith(normalized)));
}

export class SlashCommandRegistry {
  readonly commands = SLASH_COMMANDS;

  parse(input: string): ParsedSlashCommand | undefined {
    return parseSlashCommand(input);
  }

  suggestions(prefix: string): SlashCommand[] {
    return slashCommandSuggestions(prefix);
  }

  help(name?: string): string {
    if (name) {
      const command = this.commands.find((item) => item.name === name.toLowerCase());
      return command ? `${command.usage} — ${command.description}` : `Unknown command: /${name}`;
    }
    return ['Slash commands:', ...this.commands.map((command) => `${command.usage} — ${command.description}`)].join('\n');
  }

  async execute(input: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const parsed = parseSlashCommand(input);
    if (!parsed) return { text: 'Not a slash command.' };
    const args = parsed.args;
    switch (parsed.name) {
      case 'help':
        return { text: this.help(args[0]), action: 'help' };
      case 'mode': {
        const rawRequested = args[0]?.toLowerCase();
        const requested = (rawRequested === 'code' ? 'auto' : rawRequested) as AgentMode | undefined;
        if (!requested) return { text: `Current mode: ${ctx.getMode()}\nModes: ${AGENT_MODES.join(', ')} (code = auto)`, action: 'mode' };
        if (!AGENT_MODES.includes(requested)) return { text: `Unknown mode: ${args[0]}. Use one of: ${AGENT_MODES.join(', ')}, code`, action: 'mode' };
        return ctx.setMode(requested);
      }
      case 'models': {
        if (args[0]) return ctx.setModel(args.join(' '));
        const models = await ctx.listModels();
        const current = ctx.getCurrentModel();
        return { text: models.length ? models.map((m) => `${m.providerId}/${m.model}${current?.model === m.model && current?.providerId === m.providerId ? ' *' : ''}`).join('\n') : '(no models)', action: 'models', data: models };
      }
      case 'providers': {
        if (args[0] === 'test') return ctx.testProvider ? ctx.testProvider(args[1]) : { text: 'Provider testing is unavailable in this context.' };
        const providers = await ctx.listProviders();
        return { text: providers.length ? providers.map((p) => `${p.id}: ${p.name} — ${p.baseUrl}${p.enabled ? '' : ' (disabled)'}${p.hasApiKey ? '' : ' (no API key)'}`).join('\n') : '(no providers)', action: 'providers', data: providers };
      }
      case 'settings': {
        if (args.length >= 2 && ctx.setSetting) return ctx.setSetting(args[0]!, args.slice(1).join(' '));
        const settings = await ctx.getSettings();
        return { text: JSON.stringify(settings, null, 2), action: 'settings', data: settings };
      }
      case 'auto-approve': {
        const next = args[0] === 'on' ? true : args[0] === 'off' ? false : !ctx.getAutoApprove();
        return ctx.setAutoApprove(next);
      }
      case 'plan':
        return { text: await ctx.getPlan(), action: 'plan' };
      case 'workspace':
        return { text: await ctx.getWorkspace(), action: 'workspace' };
      case 'files':
        return { text: await ctx.listFiles(), action: 'files' };
      case 'upload':
        return ctx.upload(args);
      case 'image':
        return ctx.image(args);
      case 'diff':
        return { text: await ctx.getDiff(), action: 'diff' };
      case 'validate':
        return { text: await ctx.validate(), action: 'validate' };
      case 'rewind':
        return ctx.rewind ? ctx.rewind() : { text: 'Rewind is unavailable in this context.', action: 'rewind' };
      case 'new':
        return ctx.newTask ? ctx.newTask() : { text: 'No active task to restart.', action: 'new' };
      case 'clear':
        return ctx.clear ? ctx.clear() : { text: 'Conversation cleared.', action: 'clear' };
      case 'status':
        return { text: await ctx.status(), action: 'status' };
      case 'cancel':
        return ctx.cancel ? ctx.cancel() : { text: 'No running task to cancel.', action: 'cancel' };
      case 'mcp':
        return { text: ctx.getMcpStatus ? await ctx.getMcpStatus() : 'MCP status is unavailable in this context.', action: 'mcp' };
      case 'skills':
        return { text: ctx.listSkills ? await ctx.listSkills() : 'Skill listing is unavailable in this context.', action: 'skills' };
      case 'agents':
        return { text: ctx.listAgents ? await ctx.listAgents() : 'Agent listing is unavailable in this context.', action: 'agents' };
      case 'review':
        return ctx.review ? ctx.review() : { text: 'Review is unavailable in this context.', action: 'review' };
      case 'lsp':
        return { text: ctx.getLspStatus ? await ctx.getLspStatus() : 'Language server status is unavailable in this context.', action: 'lsp' };
      case 'exit':
        return ctx.exit ? ctx.exit() : { text: 'Goodbye.', action: 'exit' };
      default:
        return { text: `Unknown command: /${parsed.name}. Try /help.`, action: 'unknown' };
    }
  }
}

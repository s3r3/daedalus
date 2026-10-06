import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProviderConfig, ProviderConfigPublic } from '../contracts.ts';
import { normalizeModelTiers } from '../providers/llm/model-pool.ts';
import { normalizeToolProtocol } from '../providers/llm/text-protocol.ts';
import { normalizePromptFamilySetting } from '../agent/prompt-dialects.ts';
import { normalizeEditFormat, type Settings } from '../settings.ts';

export type ProviderPreset = { id: string; name: string; baseUrl: string; defaultModel?: string; supportsVision?: boolean };

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'nine-router', name: '9Router (Farid)', baseUrl: 'https://llm.ayid.cc.cd/v1', supportsVision: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', supportsVision: true },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', supportsVision: true },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'custom', name: 'Custom OpenAI-compatible', baseUrl: '' },
];

export function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

export function toPublicProvider(provider: ProviderConfig): ProviderConfigPublic {
  const { apiKey: _apiKey, ...rest } = provider;
  return { ...rest, apiKeyMasked: maskApiKey(provider.apiKey), hasApiKey: Boolean(provider.apiKey) };
}

export function sanitizeProviderInput(input: Partial<ProviderConfig> & { id?: string }): ProviderConfig {
  const id = (input.id ?? '').trim() || `provider-${Date.now().toString(36)}`;
  const name = (input.name ?? '').trim() || id;
  const baseUrl = (input.baseUrl ?? '').trim().replace(/\/$/, '');
  if (name.length === 0) throw new Error('provider name is required');
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Error('provider baseUrl must start with http:// or https://');
  return {
    id,
    name,
    baseUrl,
    apiKey: input.apiKey,
    models: [...new Set((input.models ?? []).map((m) => m.trim()).filter(Boolean))],
    defaultModel: input.defaultModel?.trim() || undefined,
    enabled: input.enabled !== false,
    supportsVision: input.supportsVision,
    visionModels: input.visionModels,
    toolProtocol: normalizeToolProtocol(input.toolProtocol),
    modelTiers: normalizeModelTiers(input.modelTiers),
    promptFamily: normalizePromptFamilySetting(input.promptFamily),
    editFormat: normalizeEditFormat(input.editFormat),
  };
}

export function seedProviderFromSettings(settings: Settings): ProviderConfig {
  return sanitizeProviderInput({
    id: 'nine-router',
    name: '9Router (Farid)',
    baseUrl: settings.llm.baseUrl,
    apiKey: settings.llm.apiKey || undefined,
    models: settings.llm.models.length > 0 ? settings.llm.models : settings.llm.model ? [settings.llm.model] : [],
    defaultModel: settings.llm.model || settings.llm.models[0] || undefined,
    enabled: true,
    supportsVision: true,
  });
}

const VISION_HINTS = /(?:vision|gpt-4o|gpt-4\.1|claude|gemini|llava|qwen.*vl|vl\b|multimodal)/i;

export class ProviderRegistry {
  #providers = new Map<string, ProviderConfig>();
  #fetch: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.#fetch = fetchImpl;
  }

  list(): ProviderConfigPublic[] {
    return [...this.#providers.values()].map(toPublicProvider);
  }

  listInternal(): ProviderConfig[] {
    return [...this.#providers.values()].map((p) => ({ ...p, models: [...p.models], visionModels: p.visionModels ? [...p.visionModels] : undefined }));
  }

  get(id: string): ProviderConfig | undefined {
    const provider = this.#providers.get(id);
    return provider ? { ...provider, models: [...provider.models], visionModels: provider.visionModels ? [...provider.visionModels] : undefined } : undefined;
  }

  getPublic(id: string): ProviderConfigPublic | undefined {
    const provider = this.get(id);
    return provider ? toPublicProvider(provider) : undefined;
  }

  upsert(input: Partial<ProviderConfig> & { id?: string }): ProviderConfigPublic {
    const provider = sanitizeProviderInput(input);
    const existing = this.#providers.get(provider.id);
    const merged: ProviderConfig = {
      ...provider,
      apiKey: provider.apiKey ?? existing?.apiKey,
      apiKeyMasked: undefined,
    };
    this.#providers.set(provider.id, merged);
    return toPublicProvider(merged);
  }

  remove(id: string): boolean {
    return this.#providers.delete(id);
  }

  setEnabled(id: string, enabled: boolean): ProviderConfigPublic | undefined {
    const provider = this.#providers.get(id);
    if (!provider) return undefined;
    provider.enabled = enabled;
    return toPublicProvider(provider);
  }

  async listModels(id?: string): Promise<Array<{ providerId: string; model: string; supportsVision: boolean }>> {
    const providers = id ? [this.#providers.get(id)].filter((p): p is ProviderConfig => Boolean(p)) : [...this.#providers.values()].filter((p) => p.enabled);
    const results: Array<{ providerId: string; model: string; supportsVision: boolean }> = [];
    for (const provider of providers) {
      const discovered = await this.#discoverModels(provider).catch(() => [] as string[]);
      const models = [...new Set([...(provider.models ?? []), ...discovered])];
      for (const model of models) results.push({ providerId: provider.id, model, supportsVision: this.modelSupportsVision(provider, model) });
    }
    return results;
  }

  async testConnection(id: string): Promise<{ ok: boolean; providerId: string; models: string[]; message: string }> {
    const provider = this.#providers.get(id);
    if (!provider) return { ok: false, providerId: id, models: [], message: `provider not found: ${id}` };
    if (!provider.baseUrl) return { ok: false, providerId: id, models: [], message: 'provider baseUrl is empty' };
    try {
      const models = await this.#discoverModels(provider);
      if (models.length > 0) provider.models = [...new Set([...provider.models, ...models])];
      return { ok: true, providerId: id, models, message: `Connection OK (${models.length} models)` };
    } catch (error) {
      return { ok: false, providerId: id, models: [], message: error instanceof Error ? error.message : String(error) };
    }
  }

  modelSupportsVision(provider: ProviderConfig, model: string): boolean {
    if (provider.visionModels?.includes(model)) return true;
    if (provider.supportsVision === false) return false;
    return provider.supportsVision === true && VISION_HINTS.test(model);
  }

  async #discoverModels(provider: ProviderConfig): Promise<string[]> {
    const response = await this.#fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`provider returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const json = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
    const entries = json.data ?? json.models ?? [];
    return entries.map((entry) => entry.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
}

type PersistedProviders = { version: 1; providers: ProviderConfig[] };

export class ProviderRegistryStore {
  readonly registry = new ProviderRegistry();
  readonly #filePath: string;

  constructor(home: string) {
    this.#filePath = join(home, 'providers.json');
  }

  get filePath(): string {
    return this.#filePath;
  }

  async load(seed?: ProviderConfig): Promise<void> {
    try {
      const raw = await readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedProviders;
      for (const provider of parsed.providers ?? []) this.registry.upsert(provider);
    } catch {
      if (seed) this.registry.upsert(seed);
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const payload: PersistedProviders = { version: 1, providers: this.registry.listInternal() };
    const tmp = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.#filePath);
    await chmod(this.#filePath, 0o600).catch(() => undefined);
  }
}

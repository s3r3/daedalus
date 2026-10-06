import { ModelPoolProvider, OpenAICompatProvider, registerProvider, type LLMProvider, type Message } from "./llm/index.ts";
import { loadSettings, type Settings } from "../settings.ts";

export type PromptSection = { id: string; content: string };

/** Versioned prompt with ordered sections (role, task, repo context, plan, tool docs, constraints). */
export type PromptTemplate = { version: string; sections: PromptSection[] };

export function buildPrompt(template: PromptTemplate): string {
  return template.sections.map((s) => `## ${s.id}\n${s.content}`).join("\n\n");
}

/** Reads LLM_* settings and registers the default OpenAI-compatible provider. */
export function createProviderFromSettings(settings: Settings = loadSettings()): LLMProvider {
  const models = settings.llm.models.length > 0 ? settings.llm.models : settings.llm.model ? [settings.llm.model] : [];
  const provider = models.length > 1
    ? new ModelPoolProvider({
        models,
        strategy: settings.llm.modelStrategy,
        createProvider: (model) => new OpenAICompatProvider({
          baseUrl: settings.llm.baseUrl,
          apiKey: settings.llm.apiKey,
          model,
          defaultTimeoutMs: settings.llm.timeoutMs ?? undefined,
        }),
      })
    : new OpenAICompatProvider({
        baseUrl: settings.llm.baseUrl,
        apiKey: settings.llm.apiKey,
        model: settings.llm.model || models[0] || "",
        defaultTimeoutMs: settings.llm.timeoutMs ?? undefined,
      });
  registerProvider(provider);
  return provider;
}

/** Build a provider for one stored provider configuration + model (single-model, no pool). */
export function createProviderForConfig(
  config: { baseUrl?: string; apiKey?: string } | undefined,
  model: string,
  options: { defaultTimeoutMs?: number } = {},
): LLMProvider {
  return new OpenAICompatProvider({
    baseUrl: config?.baseUrl ?? "",
    apiKey: config?.apiKey ?? "",
    model,
    defaultTimeoutMs: options.defaultTimeoutMs,
  });
}

export function defaultTemplate(input: { goal: string; repoPath: string }): PromptTemplate {
  return {
    version: "1.0.0",
    sections: [
      { id: "role", content: "You are Daedalus, an autonomous coding agent operating on a local repository." },
      { id: "task", content: input.goal },
      { id: "repo", content: `Repository: ${input.repoPath}` },
      { id: "constraints", content: "Only modify files inside the workspace root. Run validation before declaring done." },
    ],
  };
}

export function userMessage(text: string): Message {
  return { role: "user", content: text };
}

export function systemMessage(text: string): Message {
  return { role: "system", content: text };
}

/** Cheap heuristic token estimate (chars/4) used for budgeting until a real tokenizer is added. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export * from "./llm/index.ts";
export { instrumentProvider } from "./llm/instrument.ts";
export { DEFAULT_RETRY_POLICY, isRetryable, withRetry, type RetryPolicy } from "./llm/retry.ts";

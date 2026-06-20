import type {
  LlmProviderResult,
  LlmProviderSuccess,
  LlmResponseCase,
  LlmResponseFailure,
  LlmResponseTarget,
  LlmResponseTokenUsage,
} from './types.js';
import { collectEnvSecrets, redactSecrets, redactString, type RedactionSecret } from './redaction.js';

export interface InvokeProviderOptions {
  target: LlmResponseTarget;
  evalCase: LlmResponseCase;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  responseFormat?: OpenAiCompatibleResponseFormat;
  providerPreferences?: OpenRouterProviderPreferences;
}

interface OpenAiCompatibleOptions {
  target: LlmResponseTarget;
  evalCase: LlmResponseCase;
  apiBaseUrl: string;
  apiKey: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
  secrets: RedactionSecret[];
  responseFormat?: OpenAiCompatibleResponseFormat;
  providerPreferences?: OpenRouterProviderPreferences;
}

type ProviderFailureOnly = { status: 'failed'; failure: LlmResponseFailure };

export interface OpenAiCompatibleJsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
}

export type OpenAiCompatibleResponseFormat = OpenAiCompatibleJsonSchemaResponseFormat;

export interface OpenRouterProviderPreferences {
  require_parameters?: boolean;
}

export async function invokeProvider(options: InvokeProviderOptions): Promise<LlmProviderResult> {
  const env = options.env ?? process.env;
  switch (options.target.providerId) {
    case 'fixture':
      return invokeFixtureProvider(options.target, options.evalCase);
    case 'openrouter':
      return invokeOpenAiCompatibleProvider({
        target: options.target,
        evalCase: options.evalCase,
        apiBaseUrl: env.OPENROUTER_API_BASE_URL ?? 'https://openrouter.ai/api/v1',
        apiKey: requireEnvSecret(env, 'OPENROUTER_API_KEY'),
        fetchFn: options.fetchFn ?? fetch,
        timeoutMs: options.timeoutMs ?? 60_000,
        secrets: collectEnvSecrets(env),
        responseFormat: options.responseFormat,
        providerPreferences: options.providerPreferences,
      });
    case 'deepseek':
      return invokeOpenAiCompatibleProvider({
        target: options.target,
        evalCase: options.evalCase,
        apiBaseUrl: env.DEEPSEEK_API_BASE_URL ?? 'https://api.deepseek.com',
        apiKey: requireEnvSecret(env, 'DEEPSEEK_API_KEY'),
        fetchFn: options.fetchFn ?? fetch,
        timeoutMs: options.timeoutMs ?? 60_000,
        secrets: collectEnvSecrets(env),
        responseFormat: options.responseFormat,
      });
  }
}

function invokeFixtureProvider(target: LlmResponseTarget, evalCase: LlmResponseCase): LlmProviderResult {
  if (evalCase.modality === 'error') {
    return {
      status: 'failed',
      failure: {
        kind: 'provider_error',
        message: 'Fixture provider intentionally returned a structured failure for failure-shape coverage.',
      },
      sanitizedRawResponse: {
        fixture: true,
        caseId: evalCase.id,
        error: 'intentional fixture failure',
      },
    };
  }

  const responseTextByModality = {
    chat: 'A response eval harness should capture output text and timing metadata.',
    vision: 'The fixture image is a one-pixel transparent PNG; this fixture confirms vision artifact shape without live image secrets.',
    fallback: 'Primary vision is unavailable, so this text-only fallback names the limitation without claiming image inspection.',
  } as const;

  return {
    status: 'ok',
    responseText: responseTextByModality[evalCase.modality],
    stopReason: 'fixture_stop',
    tokenUsage: {
      inputTokens: estimateFixtureTokens([evalCase.systemPrompt, evalCase.userPrompt].filter(Boolean).join(' ')),
      outputTokens: estimateFixtureTokens(responseTextByModality[evalCase.modality]),
    },
    sanitizedRawResponse: {
      fixture: true,
      providerId: target.providerId,
      modelId: target.modelId,
      caseId: evalCase.id,
    },
  };
}

async function invokeOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): Promise<LlmProviderResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const requestBody: Record<string, unknown> = {
      model: options.target.modelId,
      messages: buildOpenAiCompatibleMessages(options.evalCase),
      max_tokens: options.evalCase.maxOutputTokens,
      temperature: options.evalCase.temperature,
    };
    if (options.responseFormat) {
      requestBody.response_format = options.responseFormat;
    }
    if (options.providerPreferences) {
      requestBody.provider = options.providerPreferences;
    }

    const response = await options.fetchFn(`${options.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const rawText = await response.text();
    const parsed = parseJsonObject(rawText);
    const sanitizedRawResponse = redactSecrets(parsed ?? rawText, options.secrets);

    if (!response.ok) {
      return {
        status: 'failed',
        failure: {
          kind: 'provider_http_error',
          message: `Provider returned HTTP ${response.status}`,
          statusCode: response.status,
        },
        sanitizedRawResponse,
      };
    }
    if (!parsed) {
      return { ...malformedResponse('Provider response was not valid JSON'), sanitizedRawResponse };
    }

    const parsedSuccess = parseOpenAiCompatibleSuccess(parsed);
    if (parsedSuccess.status === 'failed') {
      return { ...parsedSuccess, sanitizedRawResponse };
    }
    return {
      ...parsedSuccess,
      responseText: redactString(parsedSuccess.responseText, options.secrets),
      sanitizedRawResponse,
    };
  } catch (error) {
    const failure = normalizeProviderException(error);
    return {
      status: 'failed',
      failure: {
        ...failure,
        message: redactString(failure.message, options.secrets),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildOpenAiCompatibleMessages(evalCase: LlmResponseCase): unknown[] {
  const messages: unknown[] = [];
  if (evalCase.systemPrompt) {
    messages.push({ role: 'system', content: evalCase.systemPrompt });
  }
  if (evalCase.modality === 'vision') {
    if (!evalCase.imageDataUri) {
      throw new Error(`Vision case "${evalCase.id}" is missing imageDataUri`);
    }
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: evalCase.userPrompt },
        { type: 'image_url', image_url: { url: evalCase.imageDataUri } },
      ],
    });
    return messages;
  }
  messages.push({ role: 'user', content: evalCase.userPrompt });
  return messages;
}

function parseOpenAiCompatibleSuccess(value: Record<string, unknown>): LlmProviderSuccess | ProviderFailureOnly {
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return malformedResponse('Provider response did not contain choices');
  }
  const choice = choices[0];
  if (!isRecord(choice)) {
    return malformedResponse('Provider response choice was malformed');
  }
  const message = choice.message;
  if (!isRecord(message)) {
    return malformedResponse('Provider response choice.message was malformed');
  }
  const responseText = extractMessageText(message.content);
  if (!responseText || responseText.trim().length === 0) {
    return malformedResponse('Provider response message content was empty or malformed');
  }

  const usage = isRecord(value.usage) ? parseTokenUsage(value.usage) : undefined;
  const stopReason = typeof choice.finish_reason === 'string' && choice.finish_reason.trim()
    ? choice.finish_reason
    : undefined;

  return {
    status: 'ok',
    responseText,
    ...(stopReason ? { stopReason } : {}),
    ...(usage ? { tokenUsage: usage } : {}),
  };
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content.map((entry) => {
    if (!isRecord(entry)) return '';
    if (typeof entry.text === 'string') return entry.text;
    if (entry.type === 'text' && typeof entry.content === 'string') return entry.content;
    return '';
  }).filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function parseTokenUsage(usage: Record<string, unknown>): LlmResponseTokenUsage | undefined {
  const tokenUsage: LlmResponseTokenUsage = {};
  if (typeof usage.prompt_tokens === 'number') tokenUsage.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') tokenUsage.outputTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') tokenUsage.totalTokens = usage.total_tokens;
  return Object.keys(tokenUsage).length > 0 ? tokenUsage : undefined;
}

function malformedResponse(message: string): ProviderFailureOnly {
  return {
    status: 'failed',
    failure: {
      kind: 'malformed_response',
      message,
    },
  };
}

function parseJsonObject(rawText: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireEnvSecret(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required for live provider invocation`);
  }
  return value;
}

function normalizeProviderException(error: unknown): LlmResponseFailure {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { kind: 'timeout', message: 'Provider request timed out' };
  }
  if (error instanceof Error) {
    const kind = error.message.includes('required for live provider invocation')
      ? 'configuration_error'
      : 'provider_error';
    return { kind, message: error.message };
  }
  return { kind: 'provider_error', message: 'Provider invocation failed with a non-Error exception' };
}

function estimateFixtureTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().split(/\s+/).filter(Boolean).length * 1.3));
}

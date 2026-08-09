// ── Shared tool-less JSON screener transport (htm9.6 / htm9.7) ──
//
// One transport for the L2 fast screener and the L3 heavy escalation
// screener: a TOOL-LESS pi-ai provider call (dual-LLM
// discipline, CaMeL arXiv 2503.18813). The screener model SEES untrusted
// content but holds NO tools and NO capabilities — the request body carries
// no `tools`/`tool_choice`/`functions` key, an invariant pinned by the L2 and
// L3 tests.
//
// The gateway is the secret holder: pi-ai resolves the selected configured
// provider/model while the gateway supplies its vault-resolved credential. Every
// failure mode throws through the caller-supplied error factory — there is no
// silent-pass and no default response.

import type { AssistantMessage, Context as PiContext, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { COGSEC_TRANSPORT_ERROR_MAX_CHARS } from '../../../core/cogsec/intake/screening-envelope-policy.js';
import type { ProviderRuntime } from '../../../primitives/llm/provider-runtime.js';
import { LLMRequestCapability } from '../../../primitives/llm/client-request-capability.js';
import type { RoutingCandidate } from '../../../primitives/llm/routing.js';

export type ScreenerModel = string | RoutingCandidate;

export function screenerModelId(model: ScreenerModel): string {
  return typeof model === 'string' ? model : model.model;
}

export function screenerModelLabel(model: ScreenerModel): string {
  return typeof model === 'string' ? model : `${model.provider}/${model.model}`;
}

/** Gateway-owned pi-ai runtime plus the canonical model-to-provider index. */
export interface ScreenerBackend {
  runtime?: ProviderRuntime;
  requestCapability?: LLMRequestCapability;
}

export function assertScreenerBackendReady(
  backend: ScreenerBackend,
  models: readonly ScreenerModel[],
): void {
  if (!backend.runtime || !backend.requestCapability) {
    throw new Error('Intake screener pi-ai backend is not configured');
  }
  const checked = new Set<string>();
  for (const route of models) {
    if (typeof route === 'string') {
      throw new Error(`Intake screener route omitted provider identity for "${route}"`);
    }
    const label = screenerModelLabel(route);
    if (checked.has(label)) continue;
    checked.add(label);
    const { apiKey } = backend.requestCapability.getModelAndKey(route);
    if (!apiKey) {
      throw new Error(
        `Intake screener provider "${route.provider}" has no gateway-resolved credential`,
      );
    }
  }
}

/**
 * OpenAI-style chat content part for multimodal screener calls (htm9.8 vision
 * screener). Image parts carry an https URL or a `data:` URI; the request
 * stays tool-less either way.
 */
export type ScreenerUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ScreenerTestCompletionInput {
  model: ScreenerModel;
  systemPrompt: string;
  userMessage: string | ScreenerUserContentPart[];
  maxOutputTokens?: number;
  signal: AbortSignal;
}

/** Narrow test seam; production always dispatches through ProviderRuntime. */
export type ScreenerTestCompletion = (
  input: ScreenerTestCompletionInput,
) => Promise<string>;

interface ToolLessScreenerCallInput {
  backend: ScreenerBackend;
  /** Canonical provider/model route in production; string only in fetch-isolated tests. */
  model: ScreenerModel;
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
  systemPrompt: string;
  /** Plain-text user message, or multimodal content parts (vision screener). */
  userMessage: string | ScreenerUserContentPart[];
  /** Optional completion-token cap (`max_tokens`). */
  maxOutputTokens?: number;
  /** Test seam that returns assistant text without implementing a provider transport. */
  testCompletion?: ScreenerTestCompletion;
  /** Human-readable screener name used in error messages, e.g. 'L2 screener'. */
  screenerName: string;
  /** Error constructor so callers keep their own typed error hierarchy. */
  makeError: (message: string) => Error;
}

export interface ValidatedToolLessScreenerCallInput<T>
extends ToolLessScreenerCallInput {
  /** Parses and schema-validates assistant content. */
  validateContent: (content: string) => T;
  /** Identifies caller-owned schema errors that are safe to repair once. */
  isValidationError: (error: unknown) => boolean;
}

const retryableResponseFailures = new WeakSet<object>();
// Code-owned safety invariant: hostile content is never replayed by provider retries.
const PROVIDER_RETRY_DISABLED = Number(false);

const SCHEMA_REPAIR_INSTRUCTION = [
  'Your previous response failed validation. Retry once from the original input.',
  'Return one complete JSON object matching the requested schema exactly.',
  'Do not add markdown, prose, commentary, or fields outside that schema.',
].join(' ');

function responseFailure(
  input: ToolLessScreenerCallInput,
  message: string,
): Error {
  const error = input.makeError(message);
  retryableResponseFailures.add(error);
  return error;
}

function extractPiMessageText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage['content'][number], { type: 'text' }> => (
      part.type === 'text'
    ))
    .map(part => part.text)
    .join('');
}

function resolvePiModel(input: ToolLessScreenerCallInput) {
  const { runtime, requestCapability } = input.backend;
  if (!runtime || !requestCapability) {
    throw input.makeError(`${input.screenerName} pi-ai backend is not configured`);
  }
  if (typeof input.model === 'string') {
    throw input.makeError(
      `${input.screenerName} production route omitted provider identity for "${input.model}"`,
    );
  }
  const candidate = input.model;
  const { model, apiKey } = requestCapability.getModelAndKey(candidate);
  if (!apiKey) {
    throw input.makeError(
      `${input.screenerName} provider "${candidate.provider}" has no gateway-resolved credential`,
    );
  }
  return { runtime, requestCapability, candidate, model, apiKey };
}

function buildPiContext(input: ToolLessScreenerCallInput): PiContext {
  const content = typeof input.userMessage === 'string'
    ? input.userMessage
    : input.userMessage.map((part) => {
        if (part.type === 'text') return { type: 'text' as const, text: part.text };
        const match = part.image_url.url.match(/^data:([^;,]+);base64,(.*)$/u);
        if (!match || !match[1]?.startsWith('image/') || !match[2]) {
          throw input.makeError(
            `${input.screenerName} pi-ai image input must be a materialized image data URI`,
          );
        }
        return { type: 'image' as const, mimeType: match[1], data: match[2] };
      });
  return {
    systemPrompt: input.systemPrompt,
    messages: [{ role: 'user', content, timestamp: Date.now() }],
  };
}

function buildPiOptions(
  input: ToolLessScreenerCallInput,
  requestCapability: LLMRequestCapability,
  candidate: RoutingCandidate,
  api: string,
  apiKey: string,
  signal: AbortSignal,
): SimpleStreamOptions {
  const options = requestCapability.buildRequestOptions(candidate, apiKey, { signal });
  return {
    ...options,
    timeoutMs: input.timeoutMs,
    maxRetries: PROVIDER_RETRY_DISABLED,
    temperature: 0,
    ...(input.maxOutputTokens !== undefined
      ? { maxTokens: Math.min(candidate.maxTokens, input.maxOutputTokens) }
      : {}),
    onPayload: (payload) => {
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw input.makeError(`${input.screenerName} pi-ai payload must be an object`);
      }
      const next = { ...payload } as Record<string, unknown>;
      if ('tools' in next || 'tool_choice' in next || 'functions' in next) {
        throw input.makeError(`${input.screenerName} pi-ai payload unexpectedly carried tools`);
      }
      if (api === 'openai-completions') next.response_format = { type: 'json_object' };
      return next;
    },
  };
}

async function callToolLessJsonScreenerThroughPi(
  input: ToolLessScreenerCallInput,
): Promise<string> {
  const { runtime, requestCapability, candidate, model, apiKey } = resolvePiModel(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: AssistantMessage;
  try {
    response = await runtime.complete(
      model,
      buildPiContext(input),
      buildPiOptions(
        input,
        requestCapability,
        candidate,
        model.api,
        apiKey,
        controller.signal,
      ),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw input.makeError(
      controller.signal.aborted
        ? `${input.screenerName} call timed out after ${String(input.timeoutMs)}ms`
        : `${input.screenerName} call failed: ${detail}`,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw input.makeError(
      `${input.screenerName} provider failed: `
      + (response.errorMessage?.slice(0, COGSEC_TRANSPORT_ERROR_MAX_CHARS) || response.stopReason),
    );
  }
  const content = extractPiMessageText(response);
  if (content.trim().length === 0) {
    throw responseFailure(input, `${input.screenerName} response contained no assistant content`);
  }
  return content;
}

/**
 * Runs the narrow completion test seam under the same timeout and empty-content
 * fail-closed contract as the pi-ai path. Provider wire emulation belongs in
 * test-only support, never in this production module.
 */
async function callToolLessJsonScreenerThroughTestCompletion(
  input: ToolLessScreenerCallInput,
): Promise<string> {
  const complete = input.testCompletion;
  if (!complete) throw input.makeError(`${input.screenerName} test completion was not provided`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  let content: string;
  try {
    content = await complete({
      model: input.model,
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      ...(input.maxOutputTokens !== undefined
        ? { maxOutputTokens: input.maxOutputTokens }
        : {}),
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const aborted = controller.signal.aborted;
    throw input.makeError(
      aborted
        ? `${input.screenerName} call timed out after ${String(input.timeoutMs)}ms`
        : `${input.screenerName} call failed: ${detail}`,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (content.trim().length === 0) {
    throw responseFailure(input, `${input.screenerName} response contained no assistant content`);
  }
  return content;
}

async function callToolLessJsonScreener(
  input: ToolLessScreenerCallInput,
): Promise<string> {
  return input.testCompletion
    ? callToolLessJsonScreenerThroughTestCompletion(input)
    : callToolLessJsonScreenerThroughPi(input);
}

/**
 * Executes and validates a screener response, with one schema-constrained
 * repair attempt for malformed provider envelopes or caller-owned schema
 * failures. Transport, timeout, HTTP, and authentication failures are not
 * retried here; callers retain their existing fail-closed behavior and timeout
 * budget. The repair prompt never includes the malformed response or untrusted
 * content outside the original framed user message.
 */
export async function callValidatedToolLessJsonScreener<T>(
  input: ValidatedToolLessScreenerCallInput<T>,
): Promise<T> {
  const validateAttempt = async (
    callInput: ToolLessScreenerCallInput,
  ): Promise<T> => input.validateContent(await callToolLessJsonScreener(callInput));

  try {
    return await validateAttempt(input);
  } catch (error) {
    const retryableResponse = typeof error === 'object'
      && error !== null
      && retryableResponseFailures.has(error);
    if (!retryableResponse && !input.isValidationError(error)) throw error;
  }

  return validateAttempt({
    ...input,
    systemPrompt: `${input.systemPrompt}\n\n${SCHEMA_REPAIR_INSTRUCTION}`,
  });
}

/**
 * Neutralizes delimiter collisions before untrusted content is embedded between
 * `<untrusted_content>` markers in a screener prompt: any tag-like
 * `untrusted_content` sequence inside the hostile text is replaced so it cannot
 * forge, or break out of, the delimiter the screener is told to trust. Shared
 * by the L2 fast screener and the L3 heavy screener so both frame untrusted
 * content identically.
 */
export function neutralizeUntrustedDelimiters(
  text: string,
): { text: string; collisions: number } {
  let collisions = 0;
  const neutralized = text.replace(
    /<\s*\/?\s*untrusted_content\b[^<>]*>?/giu,
    () => {
      collisions += 1;
      return '[delimiter-collision-removed]';
    },
  );
  return { text: neutralized, collisions };
}

/** Tolerate ```json ... ``` fencing some models emit despite json_object mode. */
export function stripJsonFences(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z0-9]*\s*\n?/u, '');
  const closeIndex = withoutOpen.lastIndexOf('```');
  return (closeIndex >= 0 ? withoutOpen.slice(0, closeIndex) : withoutOpen).trim();
}

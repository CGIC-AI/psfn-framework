// ── Shared tool-less JSON screener transport (htm9.6 / htm9.7) ──
//
// One transport for the L2 fast screener and the L3 heavy escalation
// screener: a TOOL-LESS OpenRouter chat-completions call (dual-LLM
// discipline, CaMeL arXiv 2503.18813). The screener model SEES untrusted
// content but holds NO tools and NO capabilities — the request body carries
// no `tools`/`tool_choice`/`functions` key, an invariant pinned by the L2 and
// L3 tests.
//
// The gateway is the secret holder: callers resolve the OpenRouter base URL +
// API key (never logged) and pass them in as the backend. Every failure mode
// throws through the caller-supplied error factory — there is no silent-pass
// and no default response.

import { COGSEC_TRANSPORT_ERROR_MAX_CHARS } from '../../../core/cogsec/intake/screening-envelope-policy.js';

/** Gateway-resolved OpenRouter connection for a screener call (secret-bearing). */
export interface ScreenerBackend {
  /** OpenRouter API base URL, e.g. https://openrouter.ai/api/v1 */
  apiBaseUrl: string;
  /** Resolved OpenRouter API key (never logged). */
  apiKey: string;
}

/** Minimal fetch surface so tests inject a stub — no live network in tests. */
export type ScreenerFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

/**
 * OpenAI-style chat content part for multimodal screener calls (htm9.8 vision
 * screener). Image parts carry an https URL or a `data:` URI; the request
 * stays tool-less either way.
 */
export type ScreenerUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ToolLessScreenerCallInput {
  backend: ScreenerBackend;
  /** OpenRouter model slug (always config-resolved, never hardcoded). */
  model: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
  systemPrompt: string;
  /** Plain-text user message, or multimodal content parts (vision screener). */
  userMessage: string | ScreenerUserContentPart[];
  /** Optional completion-token cap (`max_tokens`). */
  maxOutputTokens?: number;
  /** Test seam; production uses the global fetch. */
  fetch?: ScreenerFetch;
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

function resolveFetch(input: ToolLessScreenerCallInput): ScreenerFetch {
  if (input.fetch) return input.fetch;
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== 'function') {
    throw input.makeError(`${input.screenerName} requires a fetch implementation`);
  }
  return globalFetch as unknown as ScreenerFetch;
}

function buildChatCompletionsUrl(apiBaseUrl: string): string {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  return new URL('chat/completions', base).toString();
}

interface ScreenerChoiceMessage {
  content?: unknown;
}

function extractMessageText(message: ScreenerChoiceMessage | undefined): string {
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const partText = (part as { text?: unknown }).text;
          return typeof partText === 'string' ? partText : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Executes one tool-less screener chat call and returns the assistant's text
 * content. Throws (through `makeError`) on transport failure, timeout,
 * HTTP error, or an empty/malformed provider response — never returns a
 * default.
 */
async function callToolLessJsonScreener(
  input: ToolLessScreenerCallInput,
): Promise<string> {
  const fetchImpl = resolveFetch(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  // Tool-less request body (dual-LLM discipline). There is intentionally NO
  // `tools` key: the screener sees untrusted content but holds no capabilities.
  const body: Record<string, unknown> = {
    model: input.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    ...(input.maxOutputTokens !== undefined ? { max_tokens: input.maxOutputTokens } : {}),
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userMessage },
    ],
  };

  let response: Awaited<ReturnType<ScreenerFetch>>;
  try {
    response = await fetchImpl(buildChatCompletionsUrl(input.backend.apiBaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.backend.apiKey}`,
      },
      body: JSON.stringify(body),
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

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw input.makeError(
      `${input.screenerName} returned ${String(response.status)} ${response.statusText}`
      + (detail ? `: ${detail.slice(0, COGSEC_TRANSPORT_ERROR_MAX_CHARS)}` : ''),
    );
  }

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw responseFailure(
      input,
      `${input.screenerName} returned non-JSON response: ${String(error)}`,
    );
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw responseFailure(input, `${input.screenerName} response contained no choices`);
  }
  const message = (choices[0] as { message?: ScreenerChoiceMessage }).message;
  const content = extractMessageText(message);
  if (content.trim().length === 0) {
    throw responseFailure(input, `${input.screenerName} response contained no assistant content`);
  }
  return content;
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

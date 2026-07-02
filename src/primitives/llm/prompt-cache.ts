// ── Provider prompt-cache engagement (E2.4) ──
// Model-agnostic engagement of provider prompt caching, driven by the
// models.json `promptCaching` owner policy and the PromptPlan cachePlan
// boundaries:
//
// - Anthropic (anthropic-messages API): cache_control breakpoints at the
//   cachePlan boundaries — the static boundary gets the long-lived breakpoint,
//   the session-stable boundary the second (system prompt block-level
//   breakpoints; well inside Anthropic's documented 4-breakpoint max together
//   with the pi-ai tool/message breakpoints).
// - OpenRouter targeting Anthropic models (openai-completions API):
//   cache_control breakpoints embedded in the system message content parts;
//   OpenRouter forwards them to the Anthropic backend. pi-ai already places
//   the conversation-history breakpoint on the last message for these models.
// - OpenAI responses API: prompt_cache_key / prompt_cache_retention via the
//   pi-ai `sessionId` / `cacheRetention` request options (existing
//   `openai_responses` strategy path).
// - Everything else (OpenRouter open models, local runners): no request-level
//   knob exists in the pi-ai layer on this base; the engagement is the
//   byte-stable static prefix plus telemetry ('implicit_prefix').
//
// Fail-closed: cache breakpoints are only applied when the serialized system
// prompt in the provider payload byte-matches the boundaries' prefix hashes.

import { createHash } from 'node:crypto';
import type {
  LLMSystemPromptCacheBoundaries,
  PromptCacheMechanism,
  PromptCacheRetention,
} from '../../shared/contracts/runtime.js';

export function hashPromptCacheText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Project serialized cache-prefix texts into transportable boundaries
 * (char offsets + content hashes). The prefix texts MUST be byte-exact
 * prefixes of the serialized system prompt (asserted by
 * computePromptPlanCachePrefixes before this is called).
 */
export function buildSystemPromptCacheBoundaries(input: {
  staticPrefixText: string;
  sessionStablePrefixText: string;
}): LLMSystemPromptCacheBoundaries {
  return {
    staticPrefixChars: input.staticPrefixText.length,
    staticPrefixHash: hashPromptCacheText(input.staticPrefixText),
    sessionStablePrefixChars: input.sessionStablePrefixText.length,
    sessionStablePrefixHash: hashPromptCacheText(input.sessionStablePrefixText),
  };
}

/**
 * Verify boundaries against a serialized system prompt. Fail-closed: any
 * structural or byte mismatch disqualifies the boundaries.
 */
export function verifySystemPromptCacheBoundaries(
  systemPrompt: string,
  boundaries: LLMSystemPromptCacheBoundaries,
): boolean {
  const { staticPrefixChars, sessionStablePrefixChars } = boundaries;
  if (!Number.isInteger(staticPrefixChars) || staticPrefixChars < 0) return false;
  if (!Number.isInteger(sessionStablePrefixChars) || sessionStablePrefixChars < staticPrefixChars) return false;
  if (sessionStablePrefixChars > systemPrompt.length) return false;
  if (hashPromptCacheText(systemPrompt.slice(0, staticPrefixChars)) !== boundaries.staticPrefixHash) {
    return false;
  }
  if (
    hashPromptCacheText(systemPrompt.slice(0, sessionStablePrefixChars))
    !== boundaries.sessionStablePrefixHash
  ) {
    return false;
  }
  return true;
}

/**
 * Resolve which provider cache mechanism applies to a resolved target.
 * `api` is the pi-ai model api when known (e.g. 'anthropic-messages').
 */
export function resolvePromptCacheMechanism(input: {
  provider: string;
  modelId: string;
  api?: string;
}): PromptCacheMechanism {
  const provider = input.provider.trim().toLowerCase();
  const modelId = input.modelId.trim().toLowerCase();
  const api = input.api?.trim().toLowerCase() ?? '';
  if (provider === 'anthropic' || api === 'anthropic-messages') {
    return 'anthropic_cache_control';
  }
  if (provider === 'openrouter' && modelId.startsWith('anthropic/')) {
    return 'openrouter_cache_control_passthrough';
  }
  if (api === 'openai-responses') {
    return 'openai_prompt_cache_key';
  }
  return 'implicit_prefix';
}

interface CacheControlDirective {
  type: 'ephemeral';
  ttl?: '1h';
}

interface SystemPromptCacheSegment {
  text: string;
  cacheControl?: CacheControlDirective;
}

/**
 * Split a verified system prompt into cache segments at the boundaries.
 * The static segment carries the long-lived breakpoint (1h ttl on the direct
 * Anthropic API when retention is 'long'); the session-stable segment carries
 * the second, default-lifetime breakpoint; the turn-volatile tail carries none.
 */
export function splitSystemPromptIntoCacheSegments(input: {
  systemPrompt: string;
  boundaries: LLMSystemPromptCacheBoundaries;
  retention: PromptCacheRetention;
  allowLongTtl: boolean;
}): SystemPromptCacheSegment[] {
  const { systemPrompt, boundaries } = input;
  const staticText = systemPrompt.slice(0, boundaries.staticPrefixChars);
  const sessionStableText = systemPrompt.slice(
    boundaries.staticPrefixChars,
    boundaries.sessionStablePrefixChars,
  );
  const volatileText = systemPrompt.slice(boundaries.sessionStablePrefixChars);

  const segments: SystemPromptCacheSegment[] = [];
  if (staticText.length > 0) {
    segments.push({
      text: staticText,
      cacheControl: {
        type: 'ephemeral',
        ...(input.retention === 'long' && input.allowLongTtl ? { ttl: '1h' } : {}),
      },
    });
  }
  if (sessionStableText.length > 0) {
    segments.push({
      text: sessionStableText,
      cacheControl: { type: 'ephemeral' },
    });
  }
  if (volatileText.length > 0) {
    segments.push({ text: volatileText });
  }
  return segments;
}

/** Mutable report so observability can reflect what was actually applied. */
export interface PromptCachePayloadReport {
  appliedBreakpoints: number;
}

type PayloadTransformer = (payload: unknown, model: unknown) => unknown | undefined;

function countBreakpoints(segments: SystemPromptCacheSegment[]): number {
  return segments.filter(segment => segment.cacheControl !== undefined).length;
}

function readModelBaseUrl(model: unknown): string {
  const baseUrl = (model as { baseUrl?: unknown } | null | undefined)?.baseUrl;
  return typeof baseUrl === 'string' ? baseUrl : '';
}

function transformAnthropicMessagesPayload(
  payload: Record<string, unknown>,
  model: unknown,
  input: {
    boundaries: LLMSystemPromptCacheBoundaries;
    retention: PromptCacheRetention;
    report?: PromptCachePayloadReport;
  },
): Record<string, unknown> | undefined {
  // pi-ai (non-OAuth) serializes the system prompt as a single text block:
  //   system: [{ type: 'text', text, cache_control? }]
  // Anything else (OAuth Claude-Code identity prepended, unexpected shapes)
  // is left untouched, fail-closed.
  const system = payload.system;
  let systemText: string | undefined;
  if (typeof system === 'string') {
    systemText = system;
  } else if (
    Array.isArray(system)
    && system.length === 1
    && typeof (system[0] as { text?: unknown }).text === 'string'
    && (system[0] as { type?: unknown }).type === 'text'
  ) {
    systemText = (system[0] as { text: string }).text;
  }
  if (systemText === undefined) return undefined;
  if (!verifySystemPromptCacheBoundaries(systemText, input.boundaries)) return undefined;

  const allowLongTtl = readModelBaseUrl(model).includes('api.anthropic.com');
  const segments = splitSystemPromptIntoCacheSegments({
    systemPrompt: systemText,
    boundaries: input.boundaries,
    retention: input.retention,
    allowLongTtl,
  });
  const breakpoints = countBreakpoints(segments);
  if (breakpoints === 0) return undefined;

  payload.system = segments.map(segment => ({
    type: 'text',
    text: segment.text,
    ...(segment.cacheControl ? { cache_control: segment.cacheControl } : {}),
  }));
  if (input.report) {
    input.report.appliedBreakpoints = breakpoints;
  }
  return payload;
}

function transformOpenRouterCompletionsPayload(
  payload: Record<string, unknown>,
  input: {
    boundaries: LLMSystemPromptCacheBoundaries;
    retention: PromptCacheRetention;
    report?: PromptCachePayloadReport;
  },
): Record<string, unknown> | undefined {
  // pi-ai serializes the system prompt as the first system/developer message
  // with string content. OpenRouter forwards anthropic cache_control on
  // content parts, so the passthrough shape is a parts array on that message.
  const messages = payload.messages;
  if (!Array.isArray(messages)) return undefined;
  const systemIndex = messages.findIndex((message) => {
    const role = (message as { role?: unknown } | null | undefined)?.role;
    return role === 'system' || role === 'developer';
  });
  if (systemIndex < 0) return undefined;
  const systemMessage = messages[systemIndex] as { role: string; content?: unknown };
  if (typeof systemMessage.content !== 'string') return undefined;
  if (!verifySystemPromptCacheBoundaries(systemMessage.content, input.boundaries)) return undefined;

  const segments = splitSystemPromptIntoCacheSegments({
    systemPrompt: systemMessage.content,
    boundaries: input.boundaries,
    retention: input.retention,
    allowLongTtl: false,
  });
  const breakpoints = countBreakpoints(segments);
  if (breakpoints === 0) return undefined;

  messages[systemIndex] = {
    ...systemMessage,
    content: segments.map(segment => ({
      type: 'text',
      text: segment.text,
      ...(segment.cacheControl ? { cache_control: segment.cacheControl } : {}),
    })),
  };
  if (input.report) {
    input.report.appliedBreakpoints = breakpoints;
  }
  return payload;
}

/**
 * Build a pi-ai onPayload transformer that places cache_control breakpoints
 * at the verified cachePlan boundaries. Returns undefined (payload unchanged)
 * whenever the payload shape or the system-prompt bytes do not match —
 * misaligned breakpoints are worse than none.
 */
export function createSystemPromptCacheControlPayloadTransformer(input: {
  mechanism: Extract<PromptCacheMechanism, 'anthropic_cache_control' | 'openrouter_cache_control_passthrough'>;
  boundaries: LLMSystemPromptCacheBoundaries;
  retention: PromptCacheRetention;
  report?: PromptCachePayloadReport;
}): PayloadTransformer {
  return (payload, model) => {
    if (payload === null || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    if (input.mechanism === 'anthropic_cache_control') {
      return transformAnthropicMessagesPayload(record, model, input);
    }
    return transformOpenRouterCompletionsPayload(record, input);
  };
}

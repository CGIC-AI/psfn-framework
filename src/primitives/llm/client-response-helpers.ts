import { isRecord } from '../../shared/utils/types.js';
import type {
  CompletionPurpose,
  LLMUsageCostDetails,
  LLMUsageDetails,
  ToolCall,
  ToolSchema,
} from '../../shared/contracts/runtime.js';
import { extractTextContent } from './conversion.js';
import {
  inferCallType as inferCorrelationCallType,
  type ResolvedCorrelationMetadata,
} from './correlation.js';
import type { RoutingCandidate } from './routing.js';

const PROVIDER_RESPONSE_PREFIX_ARTIFACTS = [
  '<｜begin▁of▁sentence｜>',
  '<｜begin_of_sentence｜>',
  '<|begin▁of▁sentence|>',
  '<|begin_of_sentence|>',
] as const;
const PROVIDER_RESPONSE_HEADER_ARTIFACT_PATTERN = /^#{1,6}\s+(?:(?:assistant|model|bot|character|companion|[^#\r\n]{1,80}'s)\s+)?response\s*:?(?:\r?\n|$)/iu;
const PROVIDER_RESPONSE_HEADER_POTENTIAL_MAX_CHARS = 120;
const KIMI_K3_MODEL_ID = 'moonshotai/kimi-k3';
const KIMI_K3_END_MESSAGE_ARTIFACT = '<|end_message|>';

export interface ProviderResponseTerminatorFilter {
  /** Return only text that can no longer be part of a trailing terminator. */
  push(delta: string): string;
  /** Strip a complete terminal artifact and return any ordinary withheld text. */
  finish(): string;
  /** Return all withheld text when the provider stream fails before completion. */
  flush(): string;
}

/**
 * Resolve a provider-template terminator only where live evidence proves that
 * model emits it as visible text. This is intentionally model-specific: a
 * participant may legitimately discuss the same literal token in other model
 * rooms, and broad output stripping would silently rewrite their response.
 */
function resolveProviderResponseTerminatorArtifact(
  candidate: Pick<RoutingCandidate, 'model'>,
): string | null {
  const normalizedModel = candidate.model.trim().toLowerCase().replace(/^openrouter\//u, '');
  return normalizedModel === KIMI_K3_MODEL_ID
    ? KIMI_K3_END_MESSAGE_ARTIFACT
    : null;
}

/**
 * Hold only the suffix that could still become a known terminal artifact. The
 * filter therefore works when the provider splits the marker across arbitrary
 * SSE deltas without delaying the rest of the visible reply.
 */
export function createProviderResponseTerminatorFilter(
  candidate: Pick<RoutingCandidate, 'model'>,
): ProviderResponseTerminatorFilter {
  const artifact = resolveProviderResponseTerminatorArtifact(candidate);
  let withheld = '';

  const drain = (): string => {
    if (!artifact || withheld.length === 0) {
      const visible = withheld;
      withheld = '';
      return visible;
    }

    let possibleSuffixLength = Math.min(withheld.length, artifact.length);
    while (
      possibleSuffixLength > 0
      && !artifact.startsWith(withheld.slice(-possibleSuffixLength))
    ) {
      possibleSuffixLength -= 1;
    }
    const visibleLength = withheld.length - possibleSuffixLength;
    const visible = withheld.slice(0, visibleLength);
    withheld = withheld.slice(visibleLength);
    return visible;
  };

  return {
    push(delta) {
      withheld += delta;
      return drain();
    },
    finish() {
      if (artifact && withheld === artifact) {
        withheld = '';
        return '';
      }
      const visible = withheld;
      withheld = '';
      return visible;
    },
    flush() {
      const visible = withheld;
      withheld = '';
      return visible;
    },
  };
}

export function stripProviderResponseTerminatorArtifact(
  content: string,
  candidate: Pick<RoutingCandidate, 'model'>,
): string {
  const artifact = resolveProviderResponseTerminatorArtifact(candidate);
  return artifact && content.endsWith(artifact)
    ? content.slice(0, -artifact.length)
    : content;
}

export function normalizeUsageCount(value: unknown): number {
  const numeric = toFiniteNumber(value);
  return numeric !== undefined && numeric > 0 ? Math.floor(numeric) : 0;
}

export function normalizeUsageCost(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  return numeric !== undefined && numeric >= 0 ? numeric : undefined;
}

export function normalizeUsageCountFromRecord(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const count = normalizeUsageCount(record[key]);
    if (count > 0) return count;
  }
  return 0;
}

function optionalUsageCountFromRecord(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return normalizeUsageCount(record[key]);
    }
  }
  return undefined;
}

export function optionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function normalizeLLMUsageCostDetails(value: unknown): LLMUsageCostDetails | undefined {
  const totalFromNumericCost = normalizeUsageCost(value);
  if (totalFromNumericCost !== undefined) {
    return { total: totalFromNumericCost };
  }

  if (!isRecord(value)) return undefined;
  const input = normalizeUsageCost(value.input);
  const output = normalizeUsageCost(value.output);
  const cacheRead = normalizeUsageCost(value.cacheRead);
  const cacheWrite = normalizeUsageCost(value.cacheWrite);
  const total = normalizeUsageCost(value.total);
  const currency = typeof value.currency === 'string' && value.currency.trim().length > 0
    ? value.currency.trim().toUpperCase()
    : undefined;
  if (
    input === undefined
    && output === undefined
    && cacheRead === undefined
    && cacheWrite === undefined
    && total === undefined
    && currency === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(currency ? { currency } : {}),
  };
}

function findMalformedUsageCostFields(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'number') {
    return normalizeUsageCost(value) === undefined ? ['responseUsage.cost'] : [];
  }
  if (!isRecord(value)) return ['responseUsage.cost'];

  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
  const malformed: string[] = [];
  let validMoneyFields = 0;
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    if (normalizeUsageCost(value[field]) === undefined) {
      malformed.push(`responseUsage.cost.${field}`);
    } else {
      validMoneyFields += 1;
    }
  }
  if (Object.hasOwn(value, 'currency')) {
    if (typeof value.currency !== 'string' || value.currency.trim().length === 0) {
      malformed.push('responseUsage.cost.currency');
    }
  }
  if (validMoneyFields === 0 && malformed.length === 0) {
    malformed.push('responseUsage.cost');
  }
  return malformed;
}

export function normalizeLLMUsageDetails(
  value: unknown,
  fallbackInputTokens: number,
  fallbackOutputTokens: number,
): LLMUsageDetails {
  if (value !== undefined && !isRecord(value)) {
    throw new Error('Provider usage must be an object when present');
  }
  const record = isRecord(value) ? value : {};
  const recognizedKeys = [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'totalTokens',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'prompt_cache_hit_tokens',
    'promptTokenCount',
    'candidatesTokenCount',
    'cachedContentTokenCount',
    'totalTokenCount',
    'prompt_tokens_details',
    'input_tokens_details',
    'cost',
  ] as const;
  if (value !== undefined && !recognizedKeys.some(key => Object.hasOwn(record, key))) {
    throw new Error('Unsupported provider usage shape');
  }
  const countKeys = recognizedKeys.filter(key => ![
    'prompt_tokens_details',
    'input_tokens_details',
    'cost',
  ].includes(key));
  for (const key of countKeys) {
    if (!Object.hasOwn(record, key)) continue;
    const count = record[key];
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0 || !Number.isInteger(count)) {
      throw new Error(`usage.${key} must be a non-negative integer`);
    }
  }
  const promptTokenDetails = optionalRecord(record.prompt_tokens_details);
  const inputTokenDetails = optionalRecord(record.input_tokens_details);
  for (const [detailsName, details] of [
    ['prompt_tokens_details', promptTokenDetails],
    ['input_tokens_details', inputTokenDetails],
  ] as const) {
    for (const key of ['cached_tokens', 'cache_write_tokens'] as const) {
      if (!Object.hasOwn(details, key)) continue;
      const count = details[key];
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0 || !Number.isInteger(count)) {
        throw new Error(`usage.${detailsName}.${key} must be a non-negative integer`);
      }
    }
  }
  const reportedPromptTokens = optionalUsageCountFromRecord(record, 'prompt_tokens', 'promptTokenCount');
  const responseInputTokens = optionalUsageCountFromRecord(record, 'input_tokens');
  const cacheWriteFromRaw = optionalUsageCountFromRecord(
    promptTokenDetails,
    'cache_write_tokens',
  ) ?? optionalUsageCountFromRecord(record, 'cache_creation_input_tokens') ?? 0;
  const reportedCachedTokens = optionalUsageCountFromRecord(
    promptTokenDetails,
    'cached_tokens',
  ) ?? optionalUsageCountFromRecord(
    inputTokenDetails,
    'cached_tokens',
  ) ?? optionalUsageCountFromRecord(
    record,
    'prompt_cache_hit_tokens',
    'cachedContentTokenCount',
    'cache_read_input_tokens',
  ) ?? 0;
  const cacheWrite = optionalUsageCountFromRecord(record, 'cacheWrite') ?? cacheWriteFromRaw;
  const cacheReadFromRaw = cacheWriteFromRaw > 0
    ? Math.max(0, reportedCachedTokens - cacheWriteFromRaw)
    : reportedCachedTokens;
  const cacheRead = optionalUsageCountFromRecord(record, 'cacheRead') ?? cacheReadFromRaw;
  const inputFromRaw = reportedPromptTokens !== undefined
    ? Math.max(0, reportedPromptTokens - cacheReadFromRaw - cacheWriteFromRaw)
    : responseInputTokens !== undefined
      ? (Object.hasOwn(record, 'cache_read_input_tokens') || Object.hasOwn(record, 'cache_creation_input_tokens')
          ? responseInputTokens
          : Math.max(0, responseInputTokens - cacheReadFromRaw - cacheWriteFromRaw))
      : undefined;
  const input = optionalUsageCountFromRecord(record, 'input')
    ?? inputFromRaw
    ?? normalizeUsageCount(fallbackInputTokens);
  // pi-ai 0.73.1 follows OpenAI semantics: completion_tokens already includes
  // completion_tokens_details.reasoning_tokens, so do not add reasoning again.
  const output = optionalUsageCountFromRecord(
    record,
    'output',
    'completion_tokens',
    'output_tokens',
    'candidatesTokenCount',
  )
    ?? normalizeUsageCount(fallbackOutputTokens);
  const reconciledTotalTokens = input + output + cacheRead + cacheWrite;
  const reportedTotalTokens = optionalUsageCountFromRecord(
    record,
    'totalTokens',
    'total_tokens',
    'totalTokenCount',
  );
  if (reportedTotalTokens !== undefined && reportedTotalTokens !== reconciledTotalTokens) {
    const totalKey = Object.hasOwn(record, 'totalTokens')
      ? 'totalTokens'
      : Object.hasOwn(record, 'total_tokens')
        ? 'total_tokens'
        : 'totalTokenCount';
    throw new Error(
      `usage.${totalKey} must equal input + output + cacheRead + cacheWrite (${reconciledTotalTokens})`,
    );
  }
  const totalTokens = reportedTotalTokens ?? reconciledTotalTokens;
  const cost = normalizeLLMUsageCostDetails(record.cost);
  const malformedCostFields = Object.hasOwn(record, 'cost')
    ? findMalformedUsageCostFields(record.cost)
    : [];
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    ...(cost ? { cost } : {}),
    ...(malformedCostFields.length > 0
      ? { costEvidenceConflict: { fields: malformedCostFields } }
      : {}),
    ...(isRecord(value) ? { raw: { ...value } } : {}),
  };
}

export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

export function normalizeSharedRouteKey(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return 'shared';
  }

  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${pathname}`.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

/**
 * Provenance of a tool call's arguments at the point it is diagnosed (empty-args
 * validation failure, or gateway-side stream inspection). See gu8m / mihm.
 *  - provider_emitted_empty: args empty AND either no argument-fragment bytes were
 *    streamed (the model genuinely called the tool with no arguments) OR the only
 *    fragment on the wire was a literal empty JSON object '{}' (the provider-side
 *    GLM tool-template parser failure — mihm; nothing was lost client-side).
 *  - stream_parse_dropped: args empty BUT non-empty argument-fragment bytes were
 *    streamed (fragments were lost during accumulation — the pre-patch failure mode).
 *  - validation_rejected: args are non-empty (any failure is a real schema mismatch,
 *    not lost/absent arguments).
 */
export type ToolArgumentProvenance =
  | 'provider_emitted_empty'
  | 'stream_parse_dropped'
  | 'validation_rejected';

// Byte length of a literal empty JSON object ('{}'). A tool call whose *entire*
// streamed argument payload is exactly these bytes came off the wire already empty
// (mihm: provider emitted '{}'), so it is a provider-side empty, not an accumulator
// drop — even though fragment bytes were technically observed.
export const EMPTY_JSON_OBJECT_ARGUMENT_BYTES = '{}'.length;

export function classifyToolArgumentProvenance(input: {
  args: Record<string, unknown> | undefined | null;
  argumentFragmentBytes: number;
}): ToolArgumentProvenance {
  const isEmpty = !input.args || Object.keys(input.args).length === 0;
  if (!isEmpty) {
    return 'validation_rejected';
  }
  if (
    input.argumentFragmentBytes === 0
    || input.argumentFragmentBytes === EMPTY_JSON_OBJECT_ARGUMENT_BYTES
  ) {
    return 'provider_emitted_empty';
  }
  return 'stream_parse_dropped';
}

export function resolveEmptyToolArgumentUsageMetadata(
  toolCalls: readonly ToolCall[],
  argumentFragmentBytes: number,
): Record<string, unknown> {
  const emptyProvenances = toolCalls
    .map(toolCall => classifyToolArgumentProvenance({
      args: toolCall.input,
      argumentFragmentBytes,
    }))
    .filter(provenance => provenance !== 'validation_rejected');
  if (emptyProvenances.length === 0) return {};

  // A parser-loss signal is the higher-severity aggregate when one response
  // contains multiple empty calls. The normal literal-'{}' case remains a
  // directly queryable scalar for operator model-usage projections.
  const provenance = emptyProvenances.includes('stream_parse_dropped')
    ? 'stream_parse_dropped'
    : 'provider_emitted_empty';
  return {
    emptyToolArgumentProvenance: provenance,
    toolArgumentFragmentBytes: argumentFragmentBytes,
  };
}

/**
 * A tool call is a mihm "corrupt-empty" call when its arguments are empty
 * ({} / null / undefined) AND the tool's own schema declares required properties.
 * Such a call can never satisfy validation, so it is retried (see
 * LLMClient.retryCompletionOnCorruptEmptyToolArgs) rather than dispatched. Tool
 * calls whose schema accepts {} are intentionally NOT flagged — an empty payload
 * is valid for them and must dispatch normally.
 */
export function toolInputIsEmpty(input: Record<string, unknown> | null | undefined): boolean {
  return !input || Object.keys(input).length === 0;
}

export function toolSchemaRequiresProperties(schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return false;
  const required = schema.required;
  return Array.isArray(required) && required.length > 0;
}

export function findCorruptEmptyToolCalls(
  toolCalls: readonly ToolCall[],
  tools: readonly ToolSchema[] | undefined,
): ToolCall[] {
  if (!tools || tools.length === 0) return [];
  const schemaByName = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
  return toolCalls.filter((call) => {
    if (!toolInputIsEmpty(call.input)) return false;
    // Unknown tool → we cannot prove it requires arguments, so do not flag it;
    // any downstream failure surfaces normally (no behavior change vs. today).
    return toolSchemaRequiresProperties(schemaByName.get(call.name));
  });
}

export function toDiagnosticCorrelationFields(
  correlation: ResolvedCorrelationMetadata,
): Record<string, string> {
  const fields: Record<string, string> = {};
  if (correlation.requestId) fields.requestId = correlation.requestId;
  if (correlation.turnId) fields.turnId = correlation.turnId;
  if (correlation.channelId) fields.channelId = correlation.channelId;
  return fields;
}

/**
 * Tool calls a non-streaming completion would dispatch. Canonical pi-ai responses
 * carry them as content blocks; injected/legacy transports may still expose the
 * direct `toolCalls` field. The retry decision and final response share this
 * derivation so they cannot disagree about what reaches the dispatcher.
 */
export function extractCompletionToolCalls(raw: unknown): ToolCall[] {
  if (!raw || typeof raw !== 'object') return [];
  const response = raw as { content?: unknown; toolCalls?: unknown };
  if (Array.isArray(response.toolCalls) && response.toolCalls.length > 0) {
    return response.toolCalls as ToolCall[];
  }
  return extractToolCallsFromContentBlocks(
    Array.isArray(response.content) ? response.content : undefined,
  );
}

export function extractToolCallsFromContentBlocks(blocks?: unknown[]): ToolCall[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  return blocks.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const candidate = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (candidate.type !== 'toolCall') return [];
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return [];
    return [{
      id: candidate.id,
      name: candidate.name,
      input: candidate.arguments && typeof candidate.arguments === 'object'
        ? candidate.arguments as Record<string, unknown>
        : {},
    }];
  });
}

export function assertUsableProviderResponse(
  response: {
    content?: unknown;
    toolCalls?: unknown;
  },
  candidate: RoutingCandidate,
): void {
  const contentBlocks = Array.isArray(response.content) ? response.content : undefined;
  const content = typeof response.content === 'string'
    ? response.content
    : extractTextContent(contentBlocks);
  const normalizedContent = stripProviderResponseTerminatorArtifact(
    normalizeContent(content),
    candidate,
  );
  assertNoProviderResponsePrefixArtifact(normalizedContent, candidate);
  const directToolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
  const blockToolCalls = extractToolCallsFromContentBlocks(contentBlocks);

  if (normalizedContent.trim().length > 0 || directToolCalls.length > 0 || blockToolCalls.length > 0) {
    return;
  }

  throw new Error(`LLM response from ${candidate.provider}/${candidate.model} contained no text or tool calls`);
}

function detectProviderResponsePrefixArtifact(content: string): string | null {
  const normalized = content.trimStart();
  if (!normalized) return null;
  const specialToken = PROVIDER_RESPONSE_PREFIX_ARTIFACTS.find((artifact) => normalized.startsWith(artifact));
  if (specialToken) return specialToken;
  const responseHeader = normalized.match(PROVIDER_RESPONSE_HEADER_ARTIFACT_PATTERN)?.[0]?.trim();
  return responseHeader || null;
}

export function isPotentialProviderResponsePrefixArtifact(content: string): boolean {
  const normalized = content.trimStart();
  if (!normalized) return true;
  if (detectProviderResponsePrefixArtifact(content)) return true;
  if (PROVIDER_RESPONSE_PREFIX_ARTIFACTS.some((artifact) => artifact.startsWith(normalized))) return true;
  return isPotentialProviderResponseHeaderArtifact(normalized);
}

export function assertNoProviderResponsePrefixArtifact(content: string, candidate: RoutingCandidate): void {
  const artifact = detectProviderResponsePrefixArtifact(content);
  if (!artifact) return;
  throw new Error(
    `LLM response from ${candidate.provider}/${candidate.model} began with provider template artifact ${artifact}`,
  );
}

function isPotentialProviderResponseHeaderArtifact(normalizedContent: string): boolean {
  if (!normalizedContent.startsWith('#')) return false;
  if (/\r?\n/u.test(normalizedContent)) return false;
  return normalizedContent.length <= PROVIDER_RESPONSE_HEADER_POTENTIAL_MAX_CHARS;
}

// ── Content normalization ──
// pi-ai + LiteLLM sometimes delivers content block arrays as stringified text via streaming,
// e.g. [{'type': 'text', 'text': 'actual response'}]. This strips the wrapping to prevent
// compounding on subsequent turns (stored malformatted content gets re-wrapped by the LLM).
const SQ_PREFIX = "[{'type': 'text', 'text': '";
const DQ_PREFIX = '[{"type": "text", "text": "';

function extractQuotedText(s: string, startIndex: number, quoteChar: string): string | null {
  let result = '';
  for (let i = startIndex; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === '\\') { result += '\\'; i++; }
      else if (next === quoteChar) { result += quoteChar; i++; }
      else if (next === 'n') { result += '\n'; i++; }
      else if (next === 't') { result += '\t'; i++; }
      else { result += s[i]; }
    } else if (s[i] === quoteChar) {
      // Found closing quote — return extracted text (ignore trailing garbage)
      return result;
    } else {
      result += s[i];
    }
  }
  return null; // No closing quote found
}

export function normalizeContent(content: string): string {
  let result = content;
  for (let i = 0; i < 3; i++) {
    const t = result.trim();
    if (t.startsWith(SQ_PREFIX)) {
      const extracted = extractQuotedText(t, SQ_PREFIX.length, "'");
      if (extracted !== null) { result = extracted; continue; }
    }
    if (t.startsWith(DQ_PREFIX)) {
      const extracted = extractQuotedText(t, DQ_PREFIX.length, '"');
      if (extracted !== null) { result = extracted; continue; }
    }
    break;
  }
  return result;
}

export function inferCallType(
  purpose: CompletionPurpose | 'chat',
  channelId?: string,
) {
  return inferCorrelationCallType(purpose, channelId);
}

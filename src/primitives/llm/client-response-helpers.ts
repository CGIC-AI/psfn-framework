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

export function normalizeLLMUsageDetails(
  value: unknown,
  fallbackInputTokens: number,
  fallbackOutputTokens: number,
): LLMUsageDetails {
  const record = isRecord(value) ? value : {};
  const promptTokenDetails = optionalRecord(record.prompt_tokens_details);
  const input = normalizeUsageCountFromRecord(record, 'input', 'prompt_tokens')
    || normalizeUsageCount(fallbackInputTokens);
  const output = normalizeUsageCountFromRecord(record, 'output', 'completion_tokens')
    || normalizeUsageCount(fallbackOutputTokens);
  const cacheRead = normalizeUsageCountFromRecord(record, 'cacheRead')
    || normalizeUsageCount(promptTokenDetails.cached_tokens);
  const cacheWrite = normalizeUsageCountFromRecord(record, 'cacheWrite')
    || normalizeUsageCount(promptTokenDetails.cache_write_tokens);
  const totalTokens = normalizeUsageCountFromRecord(record, 'totalTokens', 'total_tokens')
    || input + output + cacheRead + cacheWrite;
  const cost = normalizeLLMUsageCostDetails(record.cost);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    ...(cost ? { cost } : {}),
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
 * Tool calls a non-streaming completion would dispatch. Matches complete()'s final
 * derivation (the raw response's `toolCalls` field) so the mihm empty-args retry
 * decision inspects exactly what would otherwise be sent to the tools.
 */
export function extractCompletionToolCalls(raw: unknown): ToolCall[] {
  if (!raw || typeof raw !== 'object') return [];
  const toolCalls = (raw as { toolCalls?: unknown }).toolCalls;
  return Array.isArray(toolCalls) ? toolCalls as ToolCall[] : [];
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
  const normalizedContent = normalizeContent(content);
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

export function normalizeProxyModelId(provider: string, modelId: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return normalizedModelId;
  if (normalizedProvider !== 'openrouter') return normalizedModelId;
  if (normalizedModelId.startsWith('openrouter/')) return normalizedModelId;
  return normalizedModelId.includes('/')
    ? `openrouter/${normalizedModelId}`
    : normalizedModelId;
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

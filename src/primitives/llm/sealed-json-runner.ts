// ── Shared sealed-JSON LLM runner primitive ──
//
// Consolidates the repeated pattern used by sealed, tool-free JSON evaluators
// (blind review, introspection auditor & landmark reflector, ICP initiation
// consent): single-turn system+user JSON prompt, work-spec bounded execution,
// optional deadline AbortController, optional markdown JSON fence stripping,
// strict JSON object parsing, and exact-keys/bounded-text validation.

import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type { LLMContext, LLMModelHint, LLMResponse } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  buildLLMWorkSpec,
  completeWithWorkSpec,
  type CompleteWithWorkSpecOptions,
  type LLMWorkSpecInput,
} from './work-spec.js';

type SealedJsonCompletionPort = Pick<LLMProviderPort, 'complete'>;

export function stripMarkdownJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/iu.exec(trimmed);
  return fenced?.[1] !== undefined ? fenced[1].trim() : trimmed;
}

export function parseSealedJsonObject(
  content: string,
  label: string,
  options?: { allowMarkdownFence?: boolean },
): Record<string, unknown> {
  const raw = options?.allowMarkdownFence ? stripMarkdownJsonFence(content) : content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must return a JSON object`);
  }
  return parsed;
}

export function assertExactJsonKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) {
    throw new Error(`${label} returned an invalid response shape`);
  }
}

export function boundedSealedText(
  value: unknown,
  field: string,
  maximum: number,
  options?: { collapseWhitespace?: boolean },
): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const normalized = options?.collapseWhitespace
    ? value.replace(/\s+/gu, ' ').trim()
    : value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /\0/u.test(normalized)) {
    throw new Error(`${field} must be 1-${maximum} characters`);
  }
  return normalized;
}

interface SealedJsonCompletionRequest {
  llmProvider: SealedJsonCompletionPort;
  label: string;
  systemPrompt: string;
  payload: unknown;
  workSpec: LLMWorkSpecInput;
  exactKeys?: readonly string[];
  allowMarkdownFence?: boolean;
  deadlineMs?: number;
  modelHint?: LLMModelHint;
}

interface SealedJsonCompletionResult {
  parsed: Record<string, unknown>;
  response: LLMResponse;
}

export async function completeSealedJsonObject(
  request: SealedJsonCompletionRequest,
): Promise<SealedJsonCompletionResult> {
  const context: LLMContext = {
    systemPrompt: request.systemPrompt,
    messages: [{ role: 'user', content: JSON.stringify(request.payload) }],
  };
  const workSpec = buildLLMWorkSpec(request.workSpec);

  let abort: AbortController | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (request.deadlineMs !== undefined) {
    abort = new AbortController();
    deadlineTimer = setTimeout(() => abort!.abort(), request.deadlineMs);
  }

  let response: LLMResponse;
  try {
    const completionOptions: CompleteWithWorkSpecOptions | undefined =
      abort || request.modelHint
        ? {
            ...(abort ? { signal: abort.signal } : {}),
            ...(request.modelHint ? { modelHint: request.modelHint } : {}),
          }
        : undefined;
    response = await completeWithWorkSpec(
      request.llmProvider,
      context,
      workSpec,
      completionOptions,
    );
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }

  const parsed = parseSealedJsonObject(response.content, request.label, {
    ...(request.allowMarkdownFence ? { allowMarkdownFence: true } : {}),
  });
  if (request.exactKeys) {
    assertExactJsonKeys(parsed, request.exactKeys, request.label);
  }
  return { parsed, response };
}

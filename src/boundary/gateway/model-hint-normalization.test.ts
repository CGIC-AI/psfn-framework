import { describe, expect, it } from 'vitest';
import type { LLMChatParams } from './protocol.js';
import type { LLMModelHint } from '../../shared/contracts/runtime.js';
import {
  normalizeModelHint,
  OPTIONAL_MODEL_HINT_NORMALIZATION,
} from '../../primitives/llm/model-hint-routing.js';

const FULLY_POPULATED_HINT = {
  model: '  z-ai/glm-5  ',
  provider: '  OpenRouter  ',
  pin: false,
  maxTokens: 321.9,
  contextWindow: 120_000.8,
  thinkingEnabled: false,
  thinkingEffort: 'xhigh',
  temperature: 0.33,
  topP: 0.77,
  topK: 42.7,
  frequencyPenalty: -0.12,
  repetitionPenalty: 1.03,
} as const satisfies LLMModelHint;

const NORMALIZED_HINT: LLMModelHint = {
  model: 'z-ai/glm-5',
  provider: 'openrouter',
  pin: false,
  maxTokens: 321,
  contextWindow: 120_000,
  thinkingEnabled: false,
  thinkingEffort: 'xhigh',
  temperature: 0.33,
  topP: 0.77,
  topK: 42,
  frequencyPenalty: -0.12,
  repetitionPenalty: 1.03,
};

describe('normalizeModelHint', () => {
  it('normalizes all 12 fields identically for client hints and method params', () => {
    const methodParams = {
      ...FULLY_POPULATED_HINT,
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system',
    } satisfies LLMChatParams;

    expect(normalizeModelHint(FULLY_POPULATED_HINT, OPTIONAL_MODEL_HINT_NORMALIZATION))
      .toEqual(NORMALIZED_HINT);
    expect(normalizeModelHint(methodParams, OPTIONAL_MODEL_HINT_NORMALIZATION))
      .toEqual(NORMALIZED_HINT);
  });

  it('returns undefined when all 12 normalized fields are absent', () => {
    expect(normalizeModelHint({}, OPTIONAL_MODEL_HINT_NORMALIZATION)).toBeUndefined();
    expect(normalizeModelHint({
      model: ' ',
      provider: '\t',
      maxTokens: 0,
      contextWindow: Number.NaN,
      thinkingEffort: undefined,
      temperature: Number.POSITIVE_INFINITY,
      topP: 2,
      topK: -1,
    }, OPTIONAL_MODEL_HINT_NORMALIZATION)).toBeUndefined();
  });
});

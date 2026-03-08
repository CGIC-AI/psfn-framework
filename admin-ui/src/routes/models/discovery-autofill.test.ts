import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUniqueModelId, deriveDiscoveryAutofill } from './discovery-autofill';

test('deriveDiscoveryAutofill prefers openrouter hints and maps metadata fields', () => {
  const result = deriveDiscoveryAutofill({
    id: 'z-ai/glm-5',
    providerHints: ['z-ai', 'openrouter'],
    contextLength: 128_000,
    maxCompletionTokens: 16_384,
    pricing: {
      prompt: '0.0000025',
      completion: '0.00001',
    },
  });

  assert.deepEqual(result, {
    provider: 'openrouter',
    sourceType: 'openrouter',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputPer1MUsd: 2.5,
    outputPer1MUsd: 10,
  });
});

test('deriveDiscoveryAutofill falls back to model id prefix when hints are absent', () => {
  const result = deriveDiscoveryAutofill({
    id: 'anthropic/claude-sonnet',
    pricing: {
      prompt: 'not-a-number',
    },
  });

  assert.deepEqual(result, {
    provider: 'anthropic',
    sourceType: 'anthropic',
  });
});

test('buildUniqueModelId appends deterministic numeric suffixes', () => {
  const existing = new Set(['z-ai/glm-5', 'z-ai/glm-5-2']);
  assert.equal(buildUniqueModelId('z-ai/glm-5', existing), 'z-ai/glm-5-3');
  assert.equal(buildUniqueModelId('openai/gpt-4.1-mini', existing), 'openai/gpt-4.1-mini');
});

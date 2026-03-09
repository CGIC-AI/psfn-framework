import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUniqueModelId,
  deriveDiscoveryAutofill,
  resolveDiscoveredModelSelection,
} from './discovery-autofill';

test('deriveDiscoveryAutofill prefers openrouter hints and maps metadata fields', () => {
  const result = deriveDiscoveryAutofill({
    id: 'z-ai/glm-5',
    providerHints: ['z-ai', 'openrouter'],
    contextLength: 128_000,
    maxCompletionTokens: 16_384,
    supportsReasoning: true,
    supportsVision: true,
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
    supportsReasoning: true,
    supportsVision: true,
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

test('deriveDiscoveryAutofill ignores infrastructure-only hints and prefers openrouter-style ids', () => {
  const result = deriveDiscoveryAutofill({
    id: 'openrouter/deepseek/deepseek-r1',
    providerHints: ['proxy', 'litellm'],
    contextLength: 163_840,
    maxCompletionTokens: 8_192,
    pricing: {
      prompt: '0.00000055',
      completion: '0.00000219',
    },
  });

  assert.equal(result.provider, 'openrouter');
  assert.equal(result.sourceType, 'openrouter');
  assert.equal(result.contextWindow, 163_840);
  assert.equal(result.maxOutputTokens, 8_192);
  assert.equal(result.inputPer1MUsd, 0.55);
  assert.ok(result.outputPer1MUsd !== undefined);
  assert.ok(Math.abs(result.outputPer1MUsd - 2.19) < 1e-9);
});

test('resolveDiscoveredModelSelection matches exact ids and dropdown display strings', () => {
  const discovered = [
    {
      id: 'openrouter/z-ai/glm-5',
      description: 'GLM-5 (OpenRouter)',
    },
    {
      id: 'anthropic/claude-sonnet-4',
      description: 'Claude Sonnet 4',
    },
  ];

  assert.equal(resolveDiscoveredModelSelection('openrouter/z-ai/glm-5', discovered), discovered[0]);
  assert.equal(
    resolveDiscoveredModelSelection('openrouter/z-ai/glm-5 — GLM-5 (OpenRouter)', discovered),
    discovered[0],
  );
  assert.equal(resolveDiscoveredModelSelection('openrouter/z-ai/glm-5 (GLM-5)', discovered), discovered[0]);
});

test('resolveDiscoveredModelSelection handles OpenRouter/LiteLLM id variants', () => {
  const discovered = [
    {
      id: 'openrouter/meta-llama/llama-3.3-70b-instruct',
      description: 'Llama 3.3 70B',
    },
  ];

  assert.equal(
    resolveDiscoveredModelSelection('meta-llama/llama-3.3-70b-instruct', discovered),
    discovered[0],
  );
  assert.equal(
    resolveDiscoveredModelSelection('openrouter:meta-llama/llama-3.3-70b-instruct', discovered),
    discovered[0],
  );
});

test('resolveDiscoveredModelSelection falls back to unique description matches', () => {
  const discovered = [
    {
      id: 'openai/gpt-4o-mini',
      description: 'GPT-4o Mini',
    },
    {
      id: 'openai/gpt-4.1',
      description: 'GPT-4.1',
    },
  ];

  assert.equal(resolveDiscoveredModelSelection('gpt-4o mini', discovered), discovered[0]);
  assert.equal(resolveDiscoveredModelSelection('missing model', discovered), undefined);
});

test('buildUniqueModelId appends deterministic numeric suffixes', () => {
  const existing = new Set(['z-ai-glm-5', 'z-ai-glm-5-2']);
  assert.equal(buildUniqueModelId('z-ai/glm-5', existing), 'z-ai-glm-5-3');
  assert.equal(buildUniqueModelId('openai/gpt-4.1-mini', existing), 'openai-gpt-4.1-mini');
});

test('buildUniqueModelId normalizes invalid slot-key characters', () => {
  const existing = new Set<string>();
  assert.equal(buildUniqueModelId('openrouter/google/gemini-3.1-flash-lite-preview', existing), 'openrouter-google-gemini-3.1-flash-lite-preview');
  assert.equal(buildUniqueModelId('  / /  ', existing), 'model');
});

import { describe, it, expect } from 'vitest';
import { createLiteLLMModel, createOpenAICompatibleEndpointModel } from './models.js';
import { normalizeContent } from './client.js';

describe('createLiteLLMModel', () => {
  it('creates a model with correct baseUrl and api type', () => {
    const model = createLiteLLMModel({
      baseUrl: 'http://localhost:4000/v1',
      modelId: 'z-ai/glm-5',
    });

    expect(model.id).toBe('z-ai/glm-5');
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('http://localhost:4000/v1');
    expect(model.provider).toBe('litellm');
  });

  it('sets compat flags for LiteLLM proxy', () => {
    const model = createLiteLLMModel({
      baseUrl: 'http://localhost:4000/v1',
      modelId: 'test-model',
    });

    expect(model.compat).toBeDefined();
    expect(model.compat!.supportsStore).toBe(false);
    expect(model.compat!.maxTokensField).toBe('max_tokens');
  });

  it('uses provided maxTokens and contextWindow', () => {
    const model = createLiteLLMModel({
      baseUrl: 'http://localhost:4000/v1',
      modelId: 'test-model',
      maxTokens: 8192,
      contextWindow: 200_000,
    });

    expect(model.maxTokens).toBe(8192);
    expect(model.contextWindow).toBe(200_000);
  });

  it('defaults contextWindow to 128k and maxTokens to 4096', () => {
    const model = createLiteLLMModel({
      baseUrl: 'http://localhost:4000/v1',
      modelId: 'unknown-model',
    });

    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(4096);
  });
});

describe('createOpenAICompatibleEndpointModel', () => {
  it('uses caller-provided token and context values', () => {
    const model = createOpenAICompatibleEndpointModel({
      baseUrl: 'http://localhost:4000/v1',
      modelId: 'z-ai/glm-5',
      provider: 'local_endpoint',
      routeLabel: 'local endpoint',
      maxTokens: 16_384,
      contextWindow: 128_000,
    });

    expect(model.id).toBe('z-ai/glm-5');
    expect(model.provider).toBe('local_endpoint');
    expect(model.name).toBe('z-ai/glm-5 (via local endpoint)');
    expect(model.maxTokens).toBe(16_384);
    expect(model.contextWindow).toBe(128_000);
  });

  it('allows maxTokens override without model-specific fallback table', () => {
    const model = createOpenAICompatibleEndpointModel({
      baseUrl: 'http://localhost:4000/v1',
      modelId: 'z-ai/glm-5',
      provider: 'openrouter',
      maxTokens: 8192,
      contextWindow: 128_000,
    });

    expect(model.maxTokens).toBe(8_192);
    expect(model.contextWindow).toBe(128_000);
  });

  it('retains generic defaults when caller omits explicit routing metadata', () => {
    const model = createOpenAICompatibleEndpointModel({
      baseUrl: 'http://localhost:4000/v1',
      modelId: 'some/new-model',
      provider: 'local_endpoint',
    });

    expect(model.id).toBe('some/new-model');
    expect(model.api).toBe('openai-completions');
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(4096);
    expect(model.provider).toBe('local_endpoint');
  });
});

describe('normalizeContent', () => {
  it('returns plain text unchanged', () => {
    expect(normalizeContent('Hello world')).toBe('Hello world');
    expect(normalizeContent('*waves tail* Hi!')).toBe('*waves tail* Hi!');
  });

  it('unwraps single-quote content block format', () => {
    const wrapped = "[{'type': 'text', 'text': '*Cat ears perk up* Hello there!'}]";
    expect(normalizeContent(wrapped)).toBe('*Cat ears perk up* Hello there!');
  });

  it('unwraps double-quote content block format', () => {
    const wrapped = '[{"type": "text", "text": "Hello world"}]';
    expect(normalizeContent(wrapped)).toBe('Hello world');
  });

  it('handles escaped quotes in single-quote format', () => {
    const wrapped = "[{'type': 'text', 'text': 'She said \\'hello\\' back'}]";
    expect(normalizeContent(wrapped)).toBe("She said 'hello' back");
  });

  it('handles escaped backslashes', () => {
    const wrapped = "[{'type': 'text', 'text': 'path: C:\\\\Users\\\\V'}]";
    expect(normalizeContent(wrapped)).toBe('path: C:\\Users\\V');
  });

  it('unwraps double-nested content blocks', () => {
    const inner = "[{\\'type\\': \\'text\\', \\'text\\': \\'actual text\\'}]";
    const outer = `[{'type': 'text', 'text': '${inner}'}]`;
    expect(normalizeContent(outer)).toBe('actual text');
  });

  it('handles trailing garbage after content block', () => {
    // LLM sometimes outputs extra fields after the text block
    const wrapped = "[{'type': 'text', 'text': 'Hello world'}, 'type': 'text'}";
    expect(normalizeContent(wrapped)).toBe('Hello world');
  });

  it('handles trailing dict in content block array', () => {
    const wrapped = "[{'type': 'text', 'text': 'actual text'}], 'type': 'text'}";
    expect(normalizeContent(wrapped)).toBe('actual text');
  });

  it('preserves content that merely starts with bracket', () => {
    expect(normalizeContent('[some array]')).toBe('[some array]');
    expect(normalizeContent('[{partial')).toBe('[{partial');
  });

  it('handles empty content', () => {
    expect(normalizeContent('')).toBe('');
  });

  it('handles newlines in double-quote format', () => {
    const wrapped = '[{"type": "text", "text": "line1\\nline2"}]';
    expect(normalizeContent(wrapped)).toBe('line1\nline2');
  });
});

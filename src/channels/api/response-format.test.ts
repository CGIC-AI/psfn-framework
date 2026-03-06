import { describe, expect, it } from 'vitest';
import {
  buildApiErrorEnvelope,
  buildChatCompletionResponse,
  buildModelListResponse,
  buildStreamingContentChunk,
  buildStreamingErrorChunk,
  buildStreamingFinishChunk,
  buildStreamingRoleChunk,
  formatSseDataEvent,
  formatSseDoneEvent,
} from './response-format.js';

describe('buildApiErrorEnvelope', () => {
  it('builds OpenAI-compatible error payload and includes optional details', () => {
    expect(buildApiErrorEnvelope('invalid_request', 'bad payload')).toEqual({
      error: {
        message: 'bad payload',
        type: 'invalid_request',
        param: null,
        code: null,
      },
    });

    expect(buildApiErrorEnvelope('invalid_request', 'bad payload', { reason: 'schema' })).toEqual({
      error: {
        message: 'bad payload',
        type: 'invalid_request',
        param: null,
        code: null,
        details: { reason: 'schema' },
      },
    });
  });
});

describe('buildModelListResponse', () => {
  it('returns the expected model list shape', () => {
    expect(buildModelListResponse('psfn', 123)).toEqual({
      object: 'list',
      data: [{
        id: 'psfn',
        object: 'model',
        created: 123,
        owned_by: 'psfn',
      }],
    });
  });
});

describe('buildChatCompletionResponse', () => {
  it('produces completion body with token usage totals', () => {
    const response = buildChatCompletionResponse({
      id: 'chatcmpl-abc',
      created: 111,
      model: 'psfn',
      content: 'Hello world',
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(response.id).toBe('chatcmpl-abc');
    expect(response.object).toBe('chat.completion');
    expect(response.choices[0].message.content).toBe('Hello world');
    expect(response.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });
});

describe('streaming chunk builders', () => {
  const metadata = {
    completionId: 'chatcmpl-xyz',
    created: 222,
    model: 'psfn',
  };

  it('builds role/content/finish chunks with expected shape', () => {
    const roleChunk = buildStreamingRoleChunk(metadata);
    expect(roleChunk.choices[0].delta.role).toBe('assistant');
    expect(roleChunk.choices[0].finish_reason).toBeNull();

    const contentChunk = buildStreamingContentChunk(metadata, 'partial');
    expect(contentChunk.choices[0].delta.content).toBe('partial');
    expect(contentChunk.choices[0].finish_reason).toBeNull();

    const finishChunk = buildStreamingFinishChunk(metadata);
    expect(finishChunk.choices[0].delta).toEqual({});
    expect(finishChunk.choices[0].finish_reason).toBe('stop');
  });

  it('builds terminal error chunk payloads for SSE streams', () => {
    const chunk = buildStreamingErrorChunk(metadata, '\n[Error: Internal server error]');
    expect(chunk.choices[0].delta.content).toContain('Internal server error');
    expect(chunk.choices[0].finish_reason).toBe('stop');
  });
});

describe('SSE event formatters', () => {
  it('formats data and done events for event-stream output', () => {
    const chunk = buildStreamingRoleChunk({
      completionId: 'chatcmpl-xyz',
      created: 222,
      model: 'psfn',
    });
    const dataEvent = formatSseDataEvent(chunk);
    expect(dataEvent).toContain('data: {"id":"chatcmpl-xyz"');
    expect(dataEvent.endsWith('\n\n')).toBe(true);
    expect(formatSseDoneEvent()).toBe('data: [DONE]\n\n');
  });
});

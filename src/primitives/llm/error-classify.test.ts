import { describe, expect, it } from 'vitest';
import { classifyLLMError } from './error-classify.js';

describe('classifyLLMError', () => {
  it('classifies abort errors as non-retryable', () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';

    const result = classifyLLMError(error);
    expect(result.category).toBe('abort');
    expect(result.retryable).toBe(false);
  });

  it('classifies context overflow errors as non-retryable', () => {
    const error = Object.assign(new Error('prompt is too long for the model context window'), {
      status: 413,
    });

    const result = classifyLLMError(error);
    expect(result.category).toBe('context_overflow');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(413);
  });

  it('classifies rate limit errors as retryable', () => {
    const error = Object.assign(new Error('429 too many requests'), {
      statusCode: 429,
    });

    const result = classifyLLMError(error);
    expect(result.category).toBe('rate_limit');
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(429);
  });

  it('classifies timeout errors as retryable', () => {
    const error = Object.assign(new Error('request timed out'), {
      code: 'ETIMEDOUT',
    });

    const result = classifyLLMError(error);
    expect(result.category).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('classifies auth errors as retryable', () => {
    const error = Object.assign(new Error('unauthorized'), {
      status: 401,
    });

    const result = classifyLLMError(error);
    expect(result.category).toBe('auth');
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(401);
  });

  it('classifies empty provider responses as retryable', () => {
    const result = classifyLLMError(
      new Error('LLM response from litellm/ChatGPTN contained no text or tool calls'),
    );

    expect(result.category).toBe('empty_response');
    expect(result.retryable).toBe(true);
  });

  it('classifies provider template artifacts as retryable empty responses', () => {
    const result = classifyLLMError(
      new Error('LLM response from litellm/ChatGPTN began with provider template artifact <｜begin▁of▁sentence｜>'),
    );

    expect(result.category).toBe('empty_response');
    expect(result.retryable).toBe(true);
  });

  it('defaults to unknown for unmatched errors', () => {
    const result = classifyLLMError(new Error('something odd happened'));
    expect(result.category).toBe('unknown');
    expect(result.retryable).toBe(true);
  });
});

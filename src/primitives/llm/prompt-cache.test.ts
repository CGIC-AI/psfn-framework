import { describe, expect, it } from 'vitest';
import {
  buildSystemPromptCacheBoundaries,
  createSystemPromptCacheControlPayloadTransformer,
  hashPromptCacheText,
  resolvePromptCacheMechanism,
  splitSystemPromptIntoCacheSegments,
  verifySystemPromptCacheBoundaries,
  type PromptCachePayloadReport,
} from './prompt-cache.js';

const STATIC_TEXT = '<character_foundation>\nYou are Purrsephone.\n</character_foundation>';
const SESSION_TEXT = '<session_notes>\nDM with Alice.\n</session_notes>';
const VOLATILE_TEXT = '<runtime_context>\nmood: curious\n</runtime_context>';

const SYSTEM_PROMPT = [STATIC_TEXT, SESSION_TEXT, VOLATILE_TEXT].join('\n\n');
const STATIC_PREFIX = STATIC_TEXT;
const SESSION_STABLE_PREFIX = `${STATIC_TEXT}\n\n${SESSION_TEXT}`;

function makeBoundaries() {
  return buildSystemPromptCacheBoundaries({
    staticPrefixText: STATIC_PREFIX,
    sessionStablePrefixText: SESSION_STABLE_PREFIX,
  });
}

describe('system prompt cache boundaries', () => {
  it('round-trips build + verify against the full system prompt', () => {
    const boundaries = makeBoundaries();
    expect(boundaries.staticPrefixChars).toBe(STATIC_PREFIX.length);
    expect(boundaries.sessionStablePrefixChars).toBe(SESSION_STABLE_PREFIX.length);
    expect(verifySystemPromptCacheBoundaries(SYSTEM_PROMPT, boundaries)).toBe(true);
  });

  it('fails closed on any byte drift in the prefix', () => {
    const boundaries = makeBoundaries();
    expect(verifySystemPromptCacheBoundaries(`X${SYSTEM_PROMPT}`, boundaries)).toBe(false);
    expect(verifySystemPromptCacheBoundaries(SYSTEM_PROMPT.slice(0, 10), boundaries)).toBe(false);
    expect(verifySystemPromptCacheBoundaries('', boundaries)).toBe(false);
    expect(
      verifySystemPromptCacheBoundaries(SYSTEM_PROMPT, {
        ...boundaries,
        staticPrefixHash: hashPromptCacheText('tampered'),
      }),
    ).toBe(false);
  });
});

describe('prompt cache mechanism resolution', () => {
  it('maps provider/model/api targets onto the supported mechanisms', () => {
    expect(resolvePromptCacheMechanism({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' }))
      .toBe('anthropic_cache_control');
    expect(resolvePromptCacheMechanism({ provider: 'litellm', modelId: 'claude-x', api: 'anthropic-messages' }))
      .toBe('anthropic_cache_control');
    expect(resolvePromptCacheMechanism({ provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5', api: 'openai-completions' }))
      .toBe('openrouter_cache_control_passthrough');
    expect(resolvePromptCacheMechanism({ provider: 'openai', modelId: 'gpt-5.2', api: 'openai-responses' }))
      .toBe('openai_prompt_cache_key');
    expect(resolvePromptCacheMechanism({ provider: 'openrouter', modelId: 'z-ai/glm-5', api: 'openai-completions' }))
      .toBe('implicit_prefix');
    expect(resolvePromptCacheMechanism({ provider: 'local_endpoint', modelId: 'qwen3-32b' }))
      .toBe('implicit_prefix');
  });
});

describe('cache segment split', () => {
  it('places the long-lived breakpoint on the static region and the second on the session-stable region', () => {
    const segments = splitSystemPromptIntoCacheSegments({
      systemPrompt: SYSTEM_PROMPT,
      boundaries: makeBoundaries(),
      retention: 'long',
      allowLongTtl: true,
    });
    expect(segments.map(segment => segment.text).join('')).toBe(SYSTEM_PROMPT);
    expect(segments).toHaveLength(3);
    expect(segments[0].cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(segments[1].cacheControl).toEqual({ type: 'ephemeral' });
    expect(segments[2].cacheControl).toBeUndefined();
  });

  it('emits at most two breakpoints and skips empty regions', () => {
    const boundaries = buildSystemPromptCacheBoundaries({
      staticPrefixText: '',
      sessionStablePrefixText: '',
    });
    const segments = splitSystemPromptIntoCacheSegments({
      systemPrompt: VOLATILE_TEXT,
      boundaries,
      retention: 'short',
      allowLongTtl: false,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0].cacheControl).toBeUndefined();
  });
});

describe('anthropic-messages payload transformer (AC2)', () => {
  it('splits the system block into cache_control breakpoints at the plan boundaries', () => {
    const report: PromptCachePayloadReport = { appliedBreakpoints: 0 };
    const transformer = createSystemPromptCacheControlPayloadTransformer({
      mechanism: 'anthropic_cache_control',
      boundaries: makeBoundaries(),
      retention: 'long',
      report,
    });
    const payload = {
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const result = transformer(payload, { baseUrl: 'https://api.anthropic.com' }) as typeof payload;
    expect(result).toBeDefined();
    expect(result.system).toEqual([
      { type: 'text', text: STATIC_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: `\n\n${SESSION_TEXT}`, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `\n\n${VOLATILE_TEXT}` },
    ]);
    // Messages untouched; total system breakpoints stay within Anthropic's
    // documented max alongside pi-ai's tool/last-message breakpoints.
    expect(result.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(report.appliedBreakpoints).toBe(2);
  });

  it('leaves the payload untouched when the system bytes do not match the boundaries', () => {
    const transformer = createSystemPromptCacheControlPayloadTransformer({
      mechanism: 'anthropic_cache_control',
      boundaries: makeBoundaries(),
      retention: 'short',
    });
    const payload = {
      system: [{ type: 'text', text: 'a completely different prompt' }],
      messages: [],
    };
    expect(transformer(payload, {})).toBeUndefined();
    expect(payload.system).toEqual([{ type: 'text', text: 'a completely different prompt' }]);
  });

  it('leaves multi-block (OAuth-shaped) system payloads untouched', () => {
    const transformer = createSystemPromptCacheControlPayloadTransformer({
      mechanism: 'anthropic_cache_control',
      boundaries: makeBoundaries(),
      retention: 'short',
    });
    const payload = {
      system: [
        { type: 'text', text: 'You are Claude Code' },
        { type: 'text', text: SYSTEM_PROMPT },
      ],
      messages: [],
    };
    expect(transformer(payload, {})).toBeUndefined();
  });
});

describe('openrouter cache_control passthrough transformer (AC2)', () => {
  it('rewrites the system message into cache_control content parts and leaves the rest byte-identical', () => {
    const report: PromptCachePayloadReport = { appliedBreakpoints: 0 };
    const transformer = createSystemPromptCacheControlPayloadTransformer({
      mechanism: 'openrouter_cache_control_passthrough',
      boundaries: makeBoundaries(),
      retention: 'long',
      report,
    });
    const payload = {
      model: 'anthropic/claude-sonnet-4.5',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
    };
    const result = transformer(payload, { provider: 'openrouter' }) as typeof payload;
    expect(result).toBeDefined();
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: [
        // OpenRouter forwards anthropic cache_control on content parts; the
        // 1h ttl is direct-Anthropic-only, so passthrough stays default ttl.
        { type: 'text', text: STATIC_PREFIX, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `\n\n${SESSION_TEXT}`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `\n\n${VOLATILE_TEXT}` },
      ],
    });
    expect(result.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(result.model).toBe('anthropic/claude-sonnet-4.5');
    expect(result.stream).toBe(true);
    expect(report.appliedBreakpoints).toBe(2);
  });

  it('fails closed when there is no string-content system message', () => {
    const transformer = createSystemPromptCacheControlPayloadTransformer({
      mechanism: 'openrouter_cache_control_passthrough',
      boundaries: makeBoundaries(),
      retention: 'short',
    });
    expect(transformer({ messages: [{ role: 'user', content: 'hi' }] }, {})).toBeUndefined();
    expect(transformer({ messages: [{ role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] }] }, {})).toBeUndefined();
    expect(transformer({}, {})).toBeUndefined();
    expect(transformer(null, {})).toBeUndefined();
  });
});

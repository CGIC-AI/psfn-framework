import { describe, expect, it, vi } from 'vitest';
import {
  contextMessagesToPiMessages,
  mergeSystemContextIntoSystemPrompt,
} from './message-conversion.js';
import { buildAuthenticityProvenance } from '../../shared/authenticity-provenance.js';

describe('contextMessagesToPiMessages', () => {
  it('maps user and assistant context messages to pi chat messages', () => {
    const result = contextMessagesToPiMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ], () => 1000);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    });
    expect(result[1]).toMatchObject({
      role: 'assistant',
      api: '',
      provider: '',
      model: '',
      stopReason: 'stop',
      timestamp: 1000,
    });
    expect((result[1] as any).content).toEqual([{ type: 'text', text: 'world' }]);
  });

  it('preserves structured assistant and tool-result messages as legal pi-ai history', () => {
    const result = contextMessagesToPiMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'trace', thinkingSignature: 'sig-1' },
          { type: 'text', text: 'world' },
          { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'test' } },
        ],
        api: 'openai-completions',
        provider: 'openrouter',
        model: 'openrouter/moonshotai/kimi-k2.5',
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 1000,
      } as any,
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'lookup',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
        timestamp: 1001,
      } as any,
    ], () => 9999);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'trace', thinkingSignature: 'sig-1' },
        { type: 'text', text: 'world' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'test' } },
      ],
      api: 'openai-completions',
      provider: 'openrouter',
      model: 'openrouter/moonshotai/kimi-k2.5',
      stopReason: 'toolUse',
      timestamp: 1000,
    });
    expect(result[1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'lookup',
      content: [{ type: 'text', text: 'done' }],
      isError: false,
      timestamp: 1001,
    });
  });

  it('keeps system context out of authored chat history', () => {
    const result = contextMessagesToPiMessages([
      { role: 'system', content: '[SYSTEM: Scheduler] heartbeat prompt' },
    ], () => 1000);

    expect(result).toEqual([]);
  });

  it('merges system context into the system prompt instead of fabricating chat history', () => {
    const systemPrompt = mergeSystemContextIntoSystemPrompt('Base instructions', [
      { role: 'user', content: 'hello' },
      { role: 'system', content: '[SYSTEM: Scheduler] heartbeat prompt' },
      { role: 'assistant', content: 'world' },
      { role: 'system', content: '[Tool result: search_logs] Returned 2 hits.' },
    ]);

    expect(systemPrompt).toBe([
      'Base instructions',
      '<session_context>',
      '[SYSTEM: Scheduler] heartbeat prompt',
      '[Tool result: search_logs] Returned 2 hits.',
      '</session_context>',
    ].join('\n\n'));
  });

  it('renders provenance markers when system context is moved into the system prompt', () => {
    const systemPrompt = mergeSystemContextIntoSystemPrompt('Base instructions', [
      {
        role: 'system',
        content: '[Tool result: search_logs] Returned 2 hits.',
        provenance: buildAuthenticityProvenance({
          kind: 'tool_result',
          sourceAuthor: 'tool',
          transformedBy: 'tool',
          wording: 'transformed',
          directSpeech: false,
          detailLoss: 'none',
          emotionalTexture: 'unknown',
          safeAsPartnerSpeech: false,
        }),
      },
    ]);

    expect(systemPrompt).toContain('kind="tool_result"');
    expect(systemPrompt).toContain('safe_as_partner_speech="false"');
    expect(systemPrompt).toContain('[Tool result: search_logs] Returned 2 hits.');
  });

  it('uses Date.now by default for each converted message', () => {
    const nowSpy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(11);

    const result = contextMessagesToPiMessages([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ]);

    expect((result[0] as any).timestamp).toBe(10);
    expect((result[1] as any).timestamp).toBe(11);
    expect(nowSpy).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('does not spend timestamps on filtered system context messages', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(77);

    const result = contextMessagesToPiMessages([
      { role: 'system', content: '[SYSTEM: Quiet Planner] hidden context' },
      { role: 'user', content: 'visible partner message' },
    ]);

    expect(result).toHaveLength(1);
    expect((result[0] as any).timestamp).toBe(77);
    expect(nowSpy).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });
});

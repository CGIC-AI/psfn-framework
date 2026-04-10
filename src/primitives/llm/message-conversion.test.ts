import { describe, expect, it, vi } from 'vitest';
import {
  contextMessagesToPiMessages,
  mergeSystemContextIntoSystemPrompt,
} from './message-conversion.js';

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

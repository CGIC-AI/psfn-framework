import { describe, expect, it, vi } from 'vitest';
import { contextMessagesToPiMessages } from './message-conversion.js';

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

  it('maps system context messages to user messages without discarding them', () => {
    const result = contextMessagesToPiMessages([
      { role: 'system', content: '[SYSTEM: Scheduler] heartbeat prompt' },
    ], () => 1000);

    expect(result).toEqual([{
      role: 'user',
      content: '[SYSTEM: Scheduler] heartbeat prompt',
      timestamp: 1000,
    }]);
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
});

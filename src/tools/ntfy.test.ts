import { describe, it, expect, vi } from 'vitest';
import { createNotifyOperatorTool, type NtfyNotifier } from './ntfy.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('notify_operator tool', () => {
  it('returns explicit success text when alert is sent', async () => {
    const notifier: NtfyNotifier = {
      notify: vi.fn().mockResolvedValue({
        status: 'sent',
        topic: 'ops',
        messageId: 'msg-1',
      }),
    };
    const tool = createNotifyOperatorTool(notifier);

    const result = await tool.execute('call-1', {
      message: 'Discord gateway offline',
      title: 'Incident',
      priority: 5,
    });

    expect(resultText(result as any)).toContain('notify_operator: success');
    expect(resultText(result as any)).toContain('topic "ops"');
    expect(resultText(result as any)).toContain('id msg-1');
    expect((result.details as any).isError).toBeUndefined();
  });

  it('returns explicit debounced text when duplicate is suppressed', async () => {
    const notifier: NtfyNotifier = {
      notify: vi.fn().mockResolvedValue({
        status: 'debounced',
        topic: 'ops',
      }),
    };
    const tool = createNotifyOperatorTool(notifier);

    const result = await tool.execute('call-2', {
      message: 'Discord gateway offline',
    });

    expect(resultText(result as any)).toContain('notify_operator: debounced');
    expect((result.details as any).isError).toBeUndefined();
  });

  it('returns explicit failure text when notifier throws', async () => {
    const notifier: NtfyNotifier = {
      notify: vi.fn().mockRejectedValue(new Error('ntfy request failed: 503 Service Unavailable')),
    };
    const tool = createNotifyOperatorTool(notifier);

    const result = await tool.execute('call-3', {
      message: 'Discord gateway offline',
    });

    expect(resultText(result as any)).toContain('notify_operator: failure');
    expect(resultText(result as any)).toContain('503 Service Unavailable');
    expect((result.details as any).isError).toBe(true);
  });

  it('fails fast when message is empty', async () => {
    const notifier: NtfyNotifier = {
      notify: vi.fn(),
    };
    const tool = createNotifyOperatorTool(notifier);

    const result = await tool.execute('call-4', {
      message: '   ',
    });

    expect(resultText(result as any)).toContain('notify_operator: failure');
    expect((result.details as any).isError).toBe(true);
    expect(notifier.notify).not.toHaveBeenCalled();
  });
});

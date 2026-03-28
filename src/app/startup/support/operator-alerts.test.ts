import { describe, expect, it, vi } from 'vitest';
import {
  createPromptGenerationFailureAlertHandler,
  formatPromptGenerationFailureAlert,
} from './operator-alerts.js';
import type { StreamTerminalFailureEvent } from '../../../agent/stream-adapter.js';
import type { NtfyNotifier } from '../../../tools/ntfy.js';

function makeEvent(): StreamTerminalFailureEvent {
  return {
    purpose: 'chat',
    attempts: 2,
    candidate: {
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.5',
      maxTokens: 8192,
    },
    candidates: [
      {
        provider: 'openrouter',
        model: 'z-ai/glm-5',
        maxTokens: 8192,
      },
      {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.5',
        maxTokens: 8192,
      },
    ],
    error: new Error('403 Key limit exceeded (total limit)'),
    correlation: {
      channelId: 'internal:heartbeat',
      callType: 'scheduled',
      purpose: 'agent.turn.prompt',
    },
    service: 'scheduled',
    process: 'agent.turn.prompt',
  };
}

describe('operator alerts', () => {
  it('formats stable prompt-generation failure alerts for ntfy delivery', () => {
    const text = formatPromptGenerationFailureAlert(makeEvent(), 'PSFN');

    expect(text).toContain('PSFN prompt generation failed after exhausting configured fallback.');
    expect(text).toContain('Service: scheduled');
    expect(text).toContain('Process: agent.turn.prompt');
    expect(text).toContain('Channel: internal:heartbeat');
    expect(text).toContain('Candidates: openrouter/z-ai/glm-5 -> openrouter/moonshotai/kimi-k2.5');
    expect(text).toContain('Error: 403 Key limit exceeded (total limit)');
  });

  it('sends a priority-5 ntfy alert for terminal prompt-generation failures', async () => {
    const notifier: NtfyNotifier = {
      notify: vi.fn().mockResolvedValue({
        status: 'sent',
        topic: 'ops',
      }),
    };
    const handler = createPromptGenerationFailureAlertHandler(notifier, 'PSFN');

    await handler(makeEvent());

    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'PSFN prompt generation failure',
      priority: 5,
      message: expect.stringContaining('Last tried: openrouter/moonshotai/kimi-k2.5'),
    }));
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  VoiceStageTimeoutError,
  buildFallbackOrder,
  resolveVoiceReliabilityBudgets,
  runWithVoiceStageBudget,
  selectFallbackCandidate,
} from './reliability.js';

describe('voice reliability policy', () => {
  it('applies retry budget for retryable stage failures', async () => {
    const task = vi.fn()
      .mockRejectedValueOnce(new Error('503 temporary upstream error'))
      .mockResolvedValue('ok');
    const sleep = vi.fn(async () => {});

    const budgets = resolveVoiceReliabilityBudgets({
      stt: {
        timeoutMs: 500,
        maxRetries: 2,
        baseDelayMs: 1,
      },
    });

    const result = await runWithVoiceStageBudget({
      stage: 'stt',
      budgets,
      task,
      retryOptions: { sleep },
    });

    expect(result).toBe('ok');
    expect(task).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('enforces timeout budgets', async () => {
    const budgets = resolveVoiceReliabilityBudgets({
      ingest: {
        timeoutMs: 5,
        maxRetries: 0,
        baseDelayMs: 0,
      },
    });

    await expect(
      runWithVoiceStageBudget({
        stage: 'ingest',
        budgets,
        task: async () => new Promise<string>(() => {}),
      }),
    ).rejects.toBeInstanceOf(VoiceStageTimeoutError);
  });

  it('selects preferred fallback candidate when available', () => {
    const selected = selectFallbackCandidate('primary', [
      { id: 'backup', value: 1 },
      { id: 'primary', value: 2 },
    ]);

    expect(selected?.id).toBe('primary');
    expect(selected?.value).toBe(2);
  });

  it('skips failed providers when building fallback order', () => {
    const order = buildFallbackOrder('elevenlabs', ['backup', 'elevenlabs', 'backup-2'], ['elevenlabs']);
    expect(order).toEqual(['backup', 'backup-2']);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  createActiveMemoryRefreshFailureAlertHandler,
  createBackupFailureAlertHandler,
  createModelBudgetThresholdAlertHandler,
  createPromptGenerationFailureAlertHandler,
  createQuarantineExpiryAlertHandler,
  createRepeatedScreeningFailureAlertHandler,
  createScheduledTaskFailureAlertHandler,
  createSleepConsolidationFailureAlertHandler,
  formatActiveMemoryRefreshFailureAlert,
  formatPromptGenerationFailureAlert,
  type ActiveMemoryRefreshEvent,
} from './operator-alerts.js';
import type { StreamTerminalFailureEvent } from '../../../core/agent/stream-adapter.js';
import type { NotificationPort } from '../../../core/tools/ntfy.js';
import type { ModelBudgetOperatorAlertClaimStorePort } from '../../../shared/contracts/model-budget-alert.js';

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
  it('formats stable prompt-generation failure alerts for operator delivery', () => {
    const text = formatPromptGenerationFailureAlert(makeEvent(), 'PSFN');

    expect(text).toContain('PSFN prompt generation failed after exhausting configured fallback.');
    expect(text).toContain('Service: scheduled');
    expect(text).toContain('Process: agent.turn.prompt');
    expect(text).toContain('Channel: internal:heartbeat');
    expect(text).toContain('Candidates: openrouter/z-ai/glm-5 -> openrouter/moonshotai/kimi-k2.5');
    expect(text).toContain('Error: 403 Key limit exceeded (total limit)');
  });

  it('sends a priority-5 operator alert for terminal prompt-generation failures', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'sent',
        topic: 'ops',
      }),
    };
    const handler = createPromptGenerationFailureAlertHandler(notifier, 'PSFN');

    await handler(makeEvent());

    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: {
        kind: 'system',
        provenance: 'system.operator_alert.prompt_generation_failure',
      },
      title: 'PSFN prompt generation failure',
      priority: 5,
      message: expect.stringContaining('Last tried: openrouter/moonshotai/kimi-k2.5'),
    }));
  });

  it('attempts prompt-generation alerts even when delivery is unconfigured', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockRejectedValue(new Error('Operator alerting has zero configured sinks')),
    };
    const handler = createPromptGenerationFailureAlertHandler(notifier, 'PSFN');

    await handler(makeEvent());

    expect(notifier.notify).toHaveBeenCalledOnce();
  });

  it('fails closed instead of inventing an operator alert identity', () => {
    expect(() => formatPromptGenerationFailureAlert(makeEvent(), '  ')).toThrow(
      'Missing companion name for operator alert: explicit identity is required',
    );
    expect(() => createPromptGenerationFailureAlertHandler({
      notify: vi.fn(),
    }, '')).toThrow('Missing companion name for operator alert: explicit identity is required');
  });
});

describe('scheduled operator alerts', () => {
  it('delivers an induced backup failure through the operator notification port', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createBackupFailureAlertHandler(notifier, 'PSFN');

    await handler({
      taskId: 'scheduled-backup',
      taskName: 'Scheduled backup',
      error: 'pg_dump exited 1',
      timestamp: 1,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: {
        kind: 'system',
        provenance: 'system.operator_alert.backup_failure',
      },
      title: 'PSFN backup failure',
      priority: 5,
      message: expect.stringContaining('pg_dump exited 1'),
    }));
  });

  it('alerts on non-backup scheduled task failures', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createScheduledTaskFailureAlertHandler(notifier, 'PSFN');

    await handler({
      taskId: 'reflection:nightly',
      taskName: 'Nightly reflection',
      type: 'every',
      error: 'reflection provider unavailable',
      timestamp: 2,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'PSFN scheduled job failure',
      message: expect.stringContaining('Nightly reflection'),
    }));
  });

  it('does not duplicate the dedicated backup failure alert', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createScheduledTaskFailureAlertHandler(notifier, 'PSFN');

    await handler({
      taskId: 'scheduled-backup',
      taskName: 'Scheduled backup',
      type: 'every',
      error: 'failed',
      timestamp: 2,
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it('alerts on fail-closed sleeptime consolidation failures', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createSleepConsolidationFailureAlertHandler(notifier, 'PSFN');

    await handler({
      sessionId: 'session-1',
      scopeKey: 'direct:user-1',
      candidateEpisodeIds: ['episode-1'],
      stage: 'thematic_grouping',
      error: 'malformed model response',
      timestamp: 3,
    });

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'PSFN sleeptime failure',
      message: expect.stringContaining('malformed model response'),
    }));
  });

  it('alerts once when fail-closed screening reaches the configured repetition threshold', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createRepeatedScreeningFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 3,
    });
    const event = {
      stage: 'l3' as const,
      sourceClass: 'image_ocr',
      error: 'L3 verdict failed schema validation',
      timestamp: 4,
    };

    await handler(event);
    expect(notify).not.toHaveBeenCalled();
    await handler(event);
    expect(notify).not.toHaveBeenCalled();
    await handler(event);
    await handler(event);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: {
        kind: 'system',
        provenance: 'system.operator_alert.repeated_screening_failure',
      },
      message: expect.stringMatching(
        /Stage: l3.*Observed runtime failures: 3.*Configured alert threshold: 3/s,
      ),
    }));
  });

  it('counts repeated screening failures independently per source class', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createRepeatedScreeningFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 2,
    });
    const event = {
      stage: 'l3' as const,
      sourceClass: 'image_ocr',
      error: 'invalid JSON',
      timestamp: 4,
    };

    await handler(event);
    await handler({ ...event, sourceClass: 'web_fetch' });
    expect(notify).not.toHaveBeenCalled();
    await handler(event);
    await handler(event);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Source class: image_ocr'),
    }));
  });

  it('fails closed when the screening repetition threshold is missing or invalid', () => {
    const { notifier } = makeFakeNotifier();
    for (const failureThreshold of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(() => createRepeatedScreeningFailureAlertHandler({
        notifier,
        companionName: 'PSFN',
        failureThreshold: failureThreshold as number | undefined,
      })).toThrow(/intakeScreeningFailureAlertThreshold/);
    }
  });

  it('makes a quarantine TTL expiry operator-visible through the notification path', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createQuarantineExpiryAlertHandler(notifier, 'PSFN');

    await handler({
      envelopeId: 'env-expired-001',
      sourceChannelId: 'discord:operator-room',
      heldAtMs: Date.parse('2026-07-19T12:00:00.000Z'),
      expiredAtMs: Date.parse('2026-07-26T12:00:00.000Z'),
      reason: 'quarantine TTL elapsed',
    });

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: {
        kind: 'system',
        provenance: 'system.operator_alert.quarantine_expiry',
      },
      priority: 5,
      message: expect.stringMatching(
        /expired before operator review.*Envelope: env-expired-001.*quarantine TTL elapsed/s,
      ),
    }));
  });
});

describe('model budget threshold alerts', () => {
  const companionId = '11111111-1111-4111-8111-111111111111';
  const thresholdEvent = {
    timestampMs: Date.parse('2026-08-20T16:00:00.000Z'),
    reason: 'daily_budget_exceeded' as const,
    purpose: 'chat',
    provider: 'openrouter',
    model: 'provider/model',
    service: 'chat',
    process: 'agent.turn.prompt',
    estimatedRequestCostUsd: 0.02,
    enforcementEnabled: false,
    budget: {
      dayKey: '2026-08-20',
      monthKey: '2026-08',
      dailySpentUsd: 5.01,
      dailyLimitUsd: 5,
      monthlySpentUsd: 80,
      monthlyLimitUsd: 100,
      dailyUnknownCostAttempts: 0,
      monthlyUnknownCostAttempts: 0,
    },
  };

  it('claims an exact durable identity before concurrent delivery', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const recordDelivery = vi.fn();
    const durableClaim = {
      attempt: 1,
      providerIdempotencyKey: `${companionId}:daily_budget_exceeded:2026-08-20`,
      recovered: false,
      recordDelivery: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const alertStore = {
      claimModelBudgetOperatorAlert: vi.fn()
        .mockResolvedValueOnce(durableClaim)
        .mockResolvedValueOnce(null),
    };
    const handler = createModelBudgetThresholdAlertHandler({
      notifier,
      companionName: 'PSFN',
      companionId,
      alertStore,
      recordDelivery,
    });

    await Promise.all([handler(thresholdEvent), handler(thresholdEvent)]);

    expect(alertStore.claimModelBudgetOperatorAlert).toHaveBeenCalledTimes(2);
    expect(alertStore.claimModelBudgetOperatorAlert).toHaveBeenCalledWith({
      companionId,
      thresholdReason: 'daily_budget_exceeded',
      windowKey: '2026-08-20',
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(durableClaim.recordDelivery).toHaveBeenCalledOnce();
    expect(recordDelivery).toHaveBeenCalledOnce();
  });

  it('delivers once per threshold window and records successful delivery evidence', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const recordDelivery = vi.fn();
    const handler = createModelBudgetThresholdAlertHandler({
      notifier,
      companionName: 'PSFN',
      companionId,
      alertStore: makeAlertStore(),
      recordDelivery,
    });

    await handler(thresholdEvent);
    await handler({ ...thresholdEvent, timestampMs: thresholdEvent.timestampMs + 1_000 });

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: {
        kind: 'system',
        provenance: 'system.operator_alert.model_budget_threshold',
      },
      title: 'PSFN daily model budget threshold',
      idempotencyKey: `${companionId}:daily_budget_exceeded:2026-08-20`,
      message: expect.stringContaining('Tracking mode: requests continue after this alert.'),
    }));
    expect(recordDelivery).toHaveBeenCalledOnce();
    expect(recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      status: 'sent',
      topic: 'ops',
      dedupeKey: `${companionId}:daily_budget_exceeded:2026-08-20`,
    }));
  });

  it('does not burn the dedupe key when delivery fails', async () => {
    const notify = vi.fn()
      .mockRejectedValueOnce(new Error('ntfy unavailable'))
      .mockResolvedValueOnce({ status: 'sent' as const, topic: 'ops' });
    const recordDelivery = vi.fn();
    const handler = createModelBudgetThresholdAlertHandler({
      notifier: { notify } as unknown as NotificationPort,
      companionName: 'PSFN',
      companionId,
      alertStore: makeAlertStore(),
      recordDelivery,
    });

    await handler(thresholdEvent);
    await handler(thresholdEvent);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(recordDelivery).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'failed' }));
    expect(recordDelivery).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'sent' }));
  });

  it('deduplicates independently for each authenticated companion in a shared gateway', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const companionA = '22222222-2222-4222-8222-222222222222';
    const companionB = '33333333-3333-4333-8333-333333333333';
    const handler = createModelBudgetThresholdAlertHandler({
      notifier,
      companionName: 'fallback-name',
      companionId,
      alertStore: makeAlertStore(),
      recordDelivery: vi.fn(),
    });

    await handler({ ...thresholdEvent, companionId: companionA });
    await handler({ ...thresholdEvent, companionId: companionB });
    await handler({ ...thresholdEvent, companionId: companionA });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: `${companionA} daily model budget threshold`,
    }));
    expect(notify).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: `${companionB} daily model budget threshold`,
    }));
  });

  it('surfaces a durable evidence write failure and releases the claim for retry', async () => {
    const { notifier } = makeFakeNotifier();
    const release = vi.fn(async () => {});
    const durableRecordDelivery = vi.fn(async () => {
      throw new Error('postgres evidence write failed');
    });
    const handler = createModelBudgetThresholdAlertHandler({
      notifier,
      companionName: 'PSFN',
      companionId,
      alertStore: {
        claimModelBudgetOperatorAlert: vi.fn(async () => ({
          attempt: 1,
          providerIdempotencyKey: `${companionId}:daily_budget_exceeded:2026-08-20`,
          recovered: false,
          recordDelivery: durableRecordDelivery,
          release,
        })),
      },
      recordDelivery: vi.fn(),
    });

    await expect(handler(thresholdEvent)).rejects.toThrow('postgres evidence write failed');
    expect(durableRecordDelivery).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});

function makeFakeNotifier(): { notifier: NotificationPort; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn(async () => ({ status: 'sent' as const, topic: 'ops' }));
  return { notifier: { notify } as unknown as NotificationPort, notify };
}

function makeAlertStore(): ModelBudgetOperatorAlertClaimStorePort {
  const delivered = new Set<string>();
  let attempt = 0;
  return {
    async claimModelBudgetOperatorAlert(identity) {
      const key = `${identity.companionId}:${identity.thresholdReason}:${identity.windowKey}`;
      if (delivered.has(key)) return null;
      attempt += 1;
      return {
        attempt,
        providerIdempotencyKey: key,
        recovered: false,
        async recordDelivery(event) {
          if (event.status !== 'failed') delivered.add(key);
        },
        async release() {},
      };
    },
  };
}

function makeRefreshEvent(
  overrides: Partial<ActiveMemoryRefreshEvent> = {},
): ActiveMemoryRefreshEvent {
  return {
    channelId: 'ch1',
    key: 'contact:c1|session:ch1',
    phase: 'degraded',
    error: 'embedding backend unavailable',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('createActiveMemoryRefreshFailureAlertHandler', () => {
  it('fails closed on a missing or invalid threshold', () => {
    const { notifier } = makeFakeNotifier();
    for (const failureThreshold of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(() => createActiveMemoryRefreshFailureAlertHandler({
        notifier,
        companionName: 'PSFN',
        failureThreshold: failureThreshold as number | undefined,
      })).toThrow(/memoryRefreshFailureAlertThreshold/);
    }
  });

  it('alerts once when consecutive failures for a key cross the config-owned threshold', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 3,
    });

    await handler(makeRefreshEvent());
    await handler(makeRefreshEvent());
    expect(notify).not.toHaveBeenCalled();

    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: expect.objectContaining({
        kind: 'system',
        provenance: 'system.operator_alert.active_memory_refresh_failure',
      }),
      title: 'PSFN active-memory refresh failing',
      priority: 5,
      message: expect.stringContaining('Consecutive failures: 3'),
    }));

    // Continued failures for the same key do not re-alert until recovery.
    await handler(makeRefreshEvent());
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('tracks consecutive failures per active-context key', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 2,
    });

    await handler(makeRefreshEvent({ key: 'key-a' }));
    await handler(makeRefreshEvent({ key: 'key-b' }));
    expect(notify).not.toHaveBeenCalled();

    await handler(makeRefreshEvent({ key: 'key-a' }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0]?.[0] as { message: string }).message).toContain('key-a');
  });

  it('resets the counter and re-arms the alert after a successful refresh', async () => {
    const { notifier, notify } = makeFakeNotifier();
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 2,
    });

    await handler(makeRefreshEvent());
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);

    await handler(makeRefreshEvent({ phase: 'ready' }));
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('retries delivery on the next failure when the notifier rejects', async () => {
    const notify = vi.fn(async () => {
      throw new Error('ntfy unreachable');
    });
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier: { notify } as unknown as NotificationPort,
      companionName: 'PSFN',
      failureThreshold: 1,
    });

    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(1);

    // Delivery failed, so the alerted state must not be faked: the next
    // degraded refresh retries the notification.
    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('attempts delivery but does not throw when every operator sink is unavailable', async () => {
    const { notifier, notify } = makeFakeNotifier();
    notify.mockRejectedValueOnce(new Error('Operator alerting has zero configured sinks'));
    const handler = createActiveMemoryRefreshFailureAlertHandler({
      notifier,
      companionName: 'PSFN',
      failureThreshold: 1,
    });

    await handler(makeRefreshEvent());
    expect(notify).toHaveBeenCalledOnce();
  });

  it('formats the alert with key, channel, failure count, and last error', () => {
    const message = formatActiveMemoryRefreshFailureAlert(
      makeRefreshEvent({ key: 'contact:c1|session:ch1', channelId: 'discord:123' }),
      'PSFN',
      4,
    );
    expect(message).toContain('PSFN active-memory context refresh is failing persistently.');
    expect(message).toContain('Context key: contact:c1|session:ch1');
    expect(message).toContain('Channel: discord:123');
    expect(message).toContain('Consecutive failures: 4');
    expect(message).toContain('Last error: embedding backend unavailable');
  });
});

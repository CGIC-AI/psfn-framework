import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import { createDefaultConcernRouteDispatcher } from './concern-route-wiring.js';

describe('default concern route wiring', () => {
  it('makes reminder and schedule routes reachable through the production dispatcher', async () => {
    const now = new Date('2026-08-14T12:00:00.000Z');
    const pendingFollowUpStore = createTestPostgresIntentionPorts({
      now: () => now,
      idFactory: () => 'follow-up-1',
    }).ports.pendingFollowUpStore;
    const dispatcher = createDefaultConcernRouteDispatcher({
      companionDataDir: mkdtempSync(join(tmpdir(), 'concern-route-wiring-')),
      eventBus: new EventBus(),
      pendingFollowUpStore,
      sessionActivity: {
        getSessionActivity: channelId => ({
          sessionId: channelId,
          channelId,
          channelType: 'discord',
          lastActivityAt: now.getTime(),
          messageCount: 1,
          lastRole: 'user',
          lastMessagePreview: 'remind me at five',
        }),
      },
      now: () => now,
    });

    const outcome = await dispatcher.dispatch({
      target: 'schedule',
      source: 'candidate_review',
      title: 'Five o’clock reminder',
      summary: 'The participant asked for a reminder at five today.',
      priority: 'high',
      reason: 'explicit temporal request',
      evidenceRefs: [{ kind: 'message', ref: '42' }],
      channelId: 'discord:primary',
      contactId: 'contact-a',
      dueAt: '2026-08-14T17:00:00.000Z',
      candidateId: 'candidate-1',
    });

    expect(outcome).toMatchObject({
      disposition: 'routed',
      substrate: 'pending_follow_up',
      targetRef: 'follow-up-1',
    });
  });

  it('never writes concern_route overflow entries into reflection-journal.jsonl (b3h5p.1)', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'concern-route-no-journal-'));
    const dispatcher = createDefaultConcernRouteDispatcher({
      companionDataDir,
      eventBus: new EventBus(),
    });

    const outcome = await dispatcher.dispatch({
      target: 'introspection',
      source: 'grooming_cap_overflow',
      title: 'Overflow concern',
      summary: 'Overflow concern should not pollute reflection-journal.jsonl.',
      priority: 'low',
      reason: 'cap reached',
      evidenceRefs: [],
      concernId: 'concern-overflow-1',
    });

    expect(outcome).toMatchObject({
      disposition: 'blocked',
      substrate: 'none',
    });
    const { existsSync } = await import('node:fs');
    const { resolveReflectionJournalPath } = await import('../../persistence/layout.js');
    expect(existsSync(resolveReflectionJournalPath(companionDataDir))).toBe(false);
  });

  it('rejects partially configured pending-follow-up routing at startup', () => {
    expect(() => createDefaultConcernRouteDispatcher({
      companionDataDir: mkdtempSync(join(tmpdir(), 'concern-route-wiring-')),
      eventBus: new EventBus(),
      pendingFollowUpStore: createTestPostgresIntentionPorts().ports.pendingFollowUpStore,
    })).toThrow('requires both pendingFollowUpStore and sessionActivity');
  });
});

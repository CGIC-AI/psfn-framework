import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import { Scheduler } from './scheduler.js';
import type { SessionEntry } from '../session/types.js';
import {
  buildAmbientPresenceNote,
  evaluateAmbientPresenceEligibility,
  registerAmbientPresenceTask,
} from './ambient-presence.js';

const restWindow = {
  enabled: true,
  startLocalTime: '00:00',
  endLocalTime: '09:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 180,
};

function entry(overrides: Partial<SessionEntry> & Pick<SessionEntry, 'role' | 'timestamp'>): SessionEntry {
  return {
    id: overrides.id ?? 1,
    channelId: overrides.channelId ?? 'api:main',
    content: overrides.content ?? 'hello',
    ...overrides,
  };
}

describe('evaluateAmbientPresenceEligibility', () => {
  it('allows quiet-time internal notes after a gated overnight idle gap', () => {
    const lastAt = Date.parse('2026-06-10T22:00:00.000Z');
    const nowMs = Date.parse('2026-06-11T06:00:00.000Z');

    const decision = evaluateAmbientPresenceEligibility({
      session: { sessionId: 'api:main', channelType: 'api', timestamp: lastAt },
      recentEntries: [
        entry({ role: 'user', timestamp: lastAt - 60_000 }),
        entry({ role: 'assistant', timestamp: lastAt }),
      ],
      restWindow,
      nowMs,
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'eligible',
      sessionId: 'api:main',
      idleGapMs: nowMs - lastAt,
      timeTexture: {
        kind: 'overnight',
        reconnectionWarmth: 'medium',
      },
    });
    expect(buildAmbientPresenceNote(decision as Extract<typeof decision, { allowed: true }>))
      .toContain('No outbound message was sent and no LLM call was made.');
  });

  it('blocks notes outside the configured rest window', () => {
    const lastAt = Date.parse('2026-06-10T23:00:00.000Z');
    const decision = evaluateAmbientPresenceEligibility({
      session: { sessionId: 'api:main', channelType: 'api', timestamp: lastAt },
      recentEntries: [
        entry({ role: 'user', timestamp: lastAt }),
      ],
      restWindow,
      nowMs: Date.parse('2026-06-11T14:00:00.000Z'),
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: 'outside_rest_window',
    });
  });

  it('blocks repeated notes inside the anti-loop interval', () => {
    const lastAt = Date.parse('2026-06-10T22:00:00.000Z');
    const nowMs = Date.parse('2026-06-11T06:00:00.000Z');

    expect(evaluateAmbientPresenceEligibility({
      session: { sessionId: 'api:main', channelType: 'api', timestamp: lastAt },
      recentEntries: [
        entry({ role: 'user', timestamp: lastAt }),
      ],
      restWindow,
      nowMs,
      lastAmbientNoteAtMs: nowMs - 60_000,
    })).toMatchObject({
      allowed: false,
      reason: 'anti_loop_recent_note',
    });
  });

  it('blocks public or broadcast session surfaces at the privacy boundary', () => {
    expect(evaluateAmbientPresenceEligibility({
      session: { sessionId: 'twitter:timeline', channelType: 'api', timestamp: 1 },
      recentEntries: [entry({ channelId: 'twitter:timeline', role: 'user', timestamp: 1 })],
      nowMs: 10 * 60 * 60_000,
    })).toMatchObject({
      allowed: false,
      reason: 'privacy_boundary',
    });
  });
});

describe('registerAmbientPresenceTask', () => {
  it('records internal notes without emitting outbound messages and anti-loops on the next tick', async () => {
    let nowMs = Date.parse('2026-06-11T05:59:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const eventBus = new EventBus();
    const sent: unknown[] = [];
    eventBus.on('message.sent', payload => sent.push(payload));
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 500 });
    const persisted: SessionEntry[] = [];
    const notes: string[] = [];
    const lastAt = Date.parse('2026-06-10T22:00:00.000Z');

    try {
      registerAmbientPresenceTask({
        scheduler,
        sessionManager: {
          resolveStartupSessionMetadata: () => ({ sessionId: 'api:main', channelType: 'api', timestamp: lastAt }),
          getRecentMessages: () => [
            entry({ id: 1, role: 'user', timestamp: lastAt - 60_000 }),
            entry({ id: 2, role: 'assistant', timestamp: lastAt }),
          ],
          getRecentSessionEntries: () => persisted,
          appendSystemNote: (_channelId, note, source) => {
            notes.push(note);
            persisted.push(entry({
              id: persisted.length + 10,
              role: 'system',
              timestamp: Date.now(),
              content: note,
              metadata: JSON.stringify({
                sessionLane: {
                  schemaVersion: 1,
                  kind: 'internal',
                  source,
                },
              }),
            }));
          },
        },
        restWindow,
        intervalMs: 1_000,
      });

      nowMs += 1_000;
      await scheduler.tick();
      expect(notes).toHaveLength(1);
      expect(sent).toHaveLength(0);
      expect(notes[0]).toContain('No outbound message was sent');

      nowMs += 1_000;
      await scheduler.tick();
      expect(notes).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses scheduler eligibility to block ambient persistence when write budget is denied', async () => {
    let nowMs = Date.parse('2026-06-11T05:59:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const eventBus = new EventBus();
    const gate = createEligibilityGate(() => ({
      getTier: () => 'custom',
      getGrantedTokens: () => new Set(),
      has: () => false,
    }));
    const scheduler = new Scheduler(
      eventBus,
      { tickIntervalMs: 100, heartbeatIntervalMs: 500 },
      { eligibilityGate: gate },
    );
    const appendSystemNote = vi.fn();
    const lastAt = Date.parse('2026-06-10T22:00:00.000Z');

    try {
      registerAmbientPresenceTask({
        scheduler,
        sessionManager: {
          resolveStartupSessionMetadata: () => ({ sessionId: 'api:main', channelType: 'api', timestamp: lastAt }),
          getRecentMessages: () => [
            entry({ role: 'user', timestamp: lastAt }),
          ],
          appendSystemNote,
        },
        restWindow,
        intervalMs: 1_000,
      });

      nowMs += 1_000;
      await scheduler.tick();

      expect(appendSystemNote).not.toHaveBeenCalled();
      expect(scheduler.getTask('ambient-presence')).toMatchObject({
        lastOutcome: 'denied',
        lastDeniedReason: 'missing_capability_tokens',
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});

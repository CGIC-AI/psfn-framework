import { describe, expect, it, vi } from 'vitest';
import type { ResolvedPresence } from './identity-claim-resolver.js';
import type {
  IdentityClaimPerceptionEvent,
  PresencePerceptionEvent,
} from './sensor-cognition-bridge.js';
import {
  PERCEPTION_PRESENCE_NOTE_SOURCE,
  composeAnonymousPresenceNote,
  composeDepartureNote,
  composeKnownArrivalNote,
  createPerceptionNoteDeliverer,
  type PerceptionNoteSink,
} from './presence-note-delivery.js';

function identityClaimEvent(
  overrides: Partial<IdentityClaimPerceptionEvent> = {},
): IdentityClaimPerceptionEvent {
  return {
    kind: 'identity_claim',
    action: 'observed',
    eventId: 'evt.claim.1',
    rawEventType: 'external.telemetry.face.identity-claim',
    source: 'sat.office',
    occurredAt: '2026-07-08T00:00:00.000Z',
    receivedAt: '2026-07-08T00:00:00.010Z',
    scope: 'face',
    satelliteId: 'sat.office',
    siteId: 'site.home',
    placeId: 'place.office',
    placeDisplayName: 'Office',
    channelId: 'satellite:office:session-1',
    hubIdentityId: 'hub:opaque-001',
    confidence: 0.95,
    claimSource: 'face',
    ...overrides,
  };
}

function presenceEvent(
  overrides: Partial<PresencePerceptionEvent> = {},
): PresencePerceptionEvent {
  return {
    kind: 'presence',
    action: 'detected',
    eventId: 'evt.presence.1',
    rawEventType: 'external.telemetry.presence-detected',
    source: 'sat.kitchen',
    occurredAt: '2026-07-08T00:00:00.000Z',
    receivedAt: '2026-07-08T00:00:00.010Z',
    scope: 'presence',
    satelliteId: 'sat.kitchen',
    siteId: 'site.home',
    placeId: 'place.kitchen',
    placeDisplayName: 'Kitchen',
    channelId: 'satellite:kitchen:session-1',
    ...overrides,
  };
}

function knownPresence(overrides: Partial<IdentityClaimPerceptionEvent> = {}): ResolvedPresence {
  const event = identityClaimEvent(overrides);
  return {
    kind: 'known',
    event,
    hubIdentityId: event.hubIdentityId,
    confidence: event.confidence,
    contactId: 'contact-partner',
    displayName: 'Partner',
    trustLevel: 'trusted',
    relationshipType: 'partner',
    isMachineIntelligence: false,
  };
}

function anonymousPresence(overrides: Partial<IdentityClaimPerceptionEvent> = {}): ResolvedPresence {
  const event = identityClaimEvent(overrides);
  return {
    kind: 'anonymous',
    reason: 'unenrolled',
    event,
    hubIdentityId: event.hubIdentityId,
    confidence: event.confidence,
  };
}

function noteSink(): { sink: PerceptionNoteSink; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = [];
  const sink: PerceptionNoteSink = {
    appendContextSystemNote: vi.fn((channelId: string, note: string, source: string) => {
      calls.push([channelId, note, source]);
    }),
  };
  return { sink, calls };
}

describe('presence-note composers', () => {
  it('names the contact and place for a known arrival', () => {
    expect(composeKnownArrivalNote('Partner', 'Office')).toBe(
      '[Presence] Partner just entered the Office.',
    );
  });

  it('stays generic for an anonymous presence', () => {
    expect(composeAnonymousPresenceNote('Kitchen')).toBe(
      '[Presence] Someone is present in the Kitchen.',
    );
  });

  it('announces an empty place on departure', () => {
    expect(composeDepartureNote('Office')).toBe('[Presence] The Office is now empty.');
  });
});

describe('createPerceptionNoteDeliverer — resolved presences', () => {
  it('delivers a known-arrival note naming the contact + place on the session channel', () => {
    const { sink, calls } = noteSink();
    createPerceptionNoteDeliverer(sink).handleResolvedPresence(knownPresence());
    expect(calls).toEqual([[
      'satellite:office:session-1',
      '[Presence] Partner just entered the Office.',
      PERCEPTION_PRESENCE_NOTE_SOURCE,
    ]]);
  });

  it('delivers a generic note for an anonymous presence, never a fabricated name', () => {
    const { sink, calls } = noteSink();
    createPerceptionNoteDeliverer(sink).handleResolvedPresence(anonymousPresence());
    expect(calls).toEqual([[
      'satellite:office:session-1',
      '[Presence] Someone is present in the Office.',
      PERCEPTION_PRESENCE_NOTE_SOURCE,
    ]]);
    expect(calls[0][1]).not.toContain('Partner');
  });

  it('resolves the place display name carried on the event', () => {
    const { sink, calls } = noteSink();
    createPerceptionNoteDeliverer(sink).handleResolvedPresence(
      knownPresence({ placeDisplayName: 'Living Area' }),
    );
    expect(calls[0][1]).toBe('[Presence] Partner just entered the Living Area.');
  });

  it('delivers nothing when the presence has no session channel scope', () => {
    const { sink, calls } = noteSink();
    createPerceptionNoteDeliverer(sink).handleResolvedPresence(
      knownPresence({ channelId: undefined }),
    );
    expect(calls).toEqual([]);
  });
});

describe('createPerceptionNoteDeliverer — presence detected/cleared', () => {
  it('delivers a generic presence note on detected', () => {
    const { sink, calls } = noteSink();
    createPerceptionNoteDeliverer(sink).handlePerceptionEvent(presenceEvent());
    expect(calls).toEqual([[
      'satellite:kitchen:session-1',
      '[Presence] Someone is present in the Kitchen.',
      PERCEPTION_PRESENCE_NOTE_SOURCE,
    ]]);
  });

  it('delivers a departure note on cleared after a prior detected', () => {
    const { sink, calls } = noteSink();
    const deliverer = createPerceptionNoteDeliverer(sink);
    deliverer.handlePerceptionEvent(presenceEvent());
    deliverer.handlePerceptionEvent(presenceEvent({ action: 'cleared', eventId: 'evt.presence.2' }));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([
      'satellite:kitchen:session-1',
      '[Presence] The Kitchen is now empty.',
      PERCEPTION_PRESENCE_NOTE_SOURCE,
    ]);
  });

  it('delivers nothing for a cleared event without a prior detect', () => {
    const { sink, calls } = noteSink();
    createPerceptionNoteDeliverer(sink).handlePerceptionEvent(
      presenceEvent({ action: 'cleared' }),
    );
    expect(calls).toEqual([]);
  });

  it('de-dups a flapping sensor: repeated detected while occupied is silent', () => {
    const { sink, calls } = noteSink();
    const deliverer = createPerceptionNoteDeliverer(sink);
    deliverer.handlePerceptionEvent(presenceEvent());
    deliverer.handlePerceptionEvent(presenceEvent({ eventId: 'evt.presence.dup' }));
    expect(calls).toHaveLength(1);
  });

  it('re-announces after a clear closes the occupancy cycle', () => {
    const { sink, calls } = noteSink();
    const deliverer = createPerceptionNoteDeliverer(sink);
    deliverer.handlePerceptionEvent(presenceEvent());
    deliverer.handlePerceptionEvent(presenceEvent({ action: 'cleared', eventId: 'c1' }));
    deliverer.handlePerceptionEvent(presenceEvent({ eventId: 'd2' }));
    expect(calls.map(call => call[1])).toEqual([
      '[Presence] Someone is present in the Kitchen.',
      '[Presence] The Kitchen is now empty.',
      '[Presence] Someone is present in the Kitchen.',
    ]);
  });

  it('a known identity observation lets a later clear announce the departure', () => {
    const { sink, calls } = noteSink();
    const deliverer = createPerceptionNoteDeliverer(sink);
    // identity claim arrives on the office channel; then presence clears there.
    deliverer.handleResolvedPresence(knownPresence());
    deliverer.handlePerceptionEvent(
      presenceEvent({
        action: 'cleared',
        channelId: 'satellite:office:session-1',
        placeDisplayName: 'Office',
        eventId: 'evt.clear.office',
      }),
    );
    expect(calls.map(call => call[1])).toEqual([
      '[Presence] Partner just entered the Office.',
      '[Presence] The Office is now empty.',
    ]);
  });

  it('ignores identity-claim events on the passthrough seam (handled via resolved sink)', () => {
    const { sink, calls } = noteSink();
    createPerceptionNoteDeliverer(sink).handlePerceptionEvent(identityClaimEvent());
    expect(calls).toEqual([]);
  });

  it('delivers nothing when a presence event has no session channel scope', () => {
    const { sink, calls } = noteSink();
    createPerceptionNoteDeliverer(sink).handlePerceptionEvent(
      presenceEvent({ channelId: undefined }),
    );
    expect(calls).toEqual([]);
  });
});

describe('no-op when unwired', () => {
  it('a bare NOOP resolved-presence sink delivers nothing (perception path stays inert)', () => {
    // The deliverer is only constructed + wired when perception is active; when
    // core-runtime leaves the sink a no-op, no note lane is touched at all.
    const { sink, calls } = noteSink();
    // Simulate "unwired": never invoke the deliverer.
    createPerceptionNoteDeliverer(sink);
    expect(calls).toEqual([]);
    expect(sink.appendContextSystemNote).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../contacts/types.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { HubIdentityResolution } from '../../enrollment/types.js';
import type { IdentityClaimPerceptionEvent, PerceptionEvent } from './sensor-cognition-bridge.js';
import {
  createIdentityClaimResolvingSink,
  resolveIdentityClaim,
  NOOP_RESOLVED_PRESENCE_SINK,
  type HubIdentityClaimResolverPort,
  type ResolvedPresence,
  type ResolvedPresenceSink,
} from './identity-claim-resolver.js';

function identityClaimEvent(
  overrides: Partial<IdentityClaimPerceptionEvent> = {},
): IdentityClaimPerceptionEvent {
  return {
    kind: 'identity_claim',
    action: 'observed',
    eventId: 'evt.claim.1',
    rawEventType: 'external.telemetry.face.identity-claim',
    source: 'sat.living',
    occurredAt: '2026-07-08T00:00:00.000Z',
    receivedAt: '2026-07-08T00:00:00.010Z',
    scope: 'face',
    satelliteId: 'sat.living',
    siteId: 'site.home',
    placeId: 'place.living',
    placeDisplayName: 'Living Area',
    hubIdentityId: 'hub:opaque-001',
    confidence: 0.95,
    claimSource: 'face',
    ...overrides,
  };
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-partner',
    displayName: 'Partner',
    trustLevel: 'trusted',
    relationshipType: 'partner',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function enrollmentPort(resolution: HubIdentityResolution): HubIdentityClaimResolverPort {
  return { resolve: vi.fn(async () => resolution) };
}

function contactStore(
  getById: (id: string) => Promise<Contact | undefined>,
): Pick<ContactStorePort, 'getById'> {
  return { getById: vi.fn(getById) };
}

const ENROLLED: HubIdentityResolution = {
  status: 'enrolled',
  binding: {
    hubIdentityId: 'hub:opaque-001',
    canonicalContactId: 'contact-partner',
    status: 'enrolled',
    enrolledAt: '2026-06-01T00:00:00.000Z',
    enrolledBy: 'operator',
    revokedAt: null,
    revokedBy: null,
    satelliteId: 'sat.living',
    endpointId: null,
  },
};

describe('resolveIdentityClaim', () => {
  it('resolves an enrolled claim to a known contact carrying trust + relationship', async () => {
    const known = contact({ trustLevel: 'trusted', relationshipType: 'partner' });
    const result = await resolveIdentityClaim({
      event: identityClaimEvent(),
      enrollmentService: enrollmentPort(ENROLLED),
      contactStore: contactStore(async () => known),
    });

    expect(result.kind).toBe('known');
    if (result.kind !== 'known') throw new Error('expected known');
    expect(result.contactId).toBe('contact-partner');
    expect(result.displayName).toBe('Partner');
    expect(result.relationshipType).toBe('partner');
    expect(result.trustLevel).toBe('trusted');
    expect(result.isMachineIntelligence).toBe(false);
    expect(result.hubIdentityId).toBe('hub:opaque-001');
  });

  it('surfaces an unenrolled claim as explicit anonymous (never a guessed name)', async () => {
    const getById = vi.fn();
    const result = await resolveIdentityClaim({
      event: identityClaimEvent(),
      enrollmentService: enrollmentPort({ status: 'unenrolled' }),
      contactStore: { getById },
    });

    expect(result).toMatchObject({ kind: 'anonymous', reason: 'unenrolled' });
    // Fail closed: an unenrolled handle never triggers a contact lookup or fabrication.
    expect(getById).not.toHaveBeenCalled();
  });

  it('surfaces a low-confidence claim as anonymous without touching the binding', async () => {
    const resolve = vi.fn();
    const getById = vi.fn();
    const result = await resolveIdentityClaim({
      event: identityClaimEvent({ confidence: 0.2 }),
      enrollmentService: { resolve },
      contactStore: { getById },
    });

    expect(result).toMatchObject({ kind: 'anonymous', reason: 'low_confidence' });
    // Weak match must not even reveal that the handle is enrolled.
    expect(resolve).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });

  it('fails closed to anonymous when an enrolled binding references a missing contact', async () => {
    const warn = vi.fn();
    const result = await resolveIdentityClaim({
      event: identityClaimEvent(),
      enrollmentService: enrollmentPort(ENROLLED),
      contactStore: contactStore(async () => undefined),
      logger: { warn },
    });

    expect(result).toMatchObject({ kind: 'anonymous', reason: 'unknown_contact' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a contact-store failure (fail-closed, deliver nothing)', async () => {
    const boom = new Error('db down');
    await expect(resolveIdentityClaim({
      event: identityClaimEvent(),
      enrollmentService: enrollmentPort(ENROLLED),
      contactStore: contactStore(async () => { throw boom; }),
    })).rejects.toBe(boom);
  });
});

describe('createIdentityClaimResolvingSink', () => {
  it('resolves identity claims and delivers the resolved presence to the sink', async () => {
    const delivered: ResolvedPresence[] = [];
    const presenceSink: ResolvedPresenceSink = {
      handleResolvedPresence: (p) => { delivered.push(p); },
    };
    const sink = createIdentityClaimResolvingSink({
      enrollmentService: enrollmentPort(ENROLLED),
      contactStore: contactStore(async () => contact()),
      presenceSink,
    });

    await sink.handlePerceptionEvent(identityClaimEvent());

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: 'known', contactId: 'contact-partner' });
  });

  it('defaults to a no-op presence sink so nothing is delivered yet (bead .14 seam)', async () => {
    const resolve = vi.fn(async (): Promise<HubIdentityResolution> => ENROLLED);
    const sink = createIdentityClaimResolvingSink({
      enrollmentService: { resolve },
      contactStore: contactStore(async () => contact()),
      // no presenceSink → NOOP_RESOLVED_PRESENCE_SINK
    });

    // Resolves (touches the port) but delivers nowhere — no throw, no delivery.
    await expect(sink.handlePerceptionEvent(identityClaimEvent())).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(NOOP_RESOLVED_PRESENCE_SINK.handleResolvedPresence(
      { kind: 'anonymous', reason: 'unenrolled' } as ResolvedPresence,
    )).toBeUndefined();
  });

  it('passes non-identity perception events through to the inner sink untouched', async () => {
    const resolve = vi.fn();
    const forwarded: PerceptionEvent[] = [];
    const sink = createIdentityClaimResolvingSink({
      enrollmentService: { resolve },
      contactStore: contactStore(async () => contact()),
      inner: { handlePerceptionEvent: (e) => { forwarded.push(e); } },
    });

    const presenceEvent: PerceptionEvent = {
      kind: 'presence',
      action: 'detected',
      eventId: 'evt.presence.1',
      rawEventType: 'external.telemetry.presence-detected',
      source: 'sat.living',
      occurredAt: '2026-07-08T00:00:00.000Z',
      receivedAt: '2026-07-08T00:00:00.010Z',
      scope: 'presence',
      satelliteId: 'sat.living',
      siteId: 'site.home',
      placeId: 'place.living',
      placeDisplayName: 'Living Area',
    };
    await sink.handlePerceptionEvent(presenceEvent);

    expect(forwarded).toEqual([presenceEvent]);
    expect(resolve).not.toHaveBeenCalled();
  });
});

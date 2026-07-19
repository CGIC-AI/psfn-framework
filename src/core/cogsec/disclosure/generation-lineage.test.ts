import { describe, expect, it } from 'vitest';
import {
  createDmConversationScope,
  createGroupConversationScope,
} from '../../session/conversation-scope.js';
import type { ContextEnvelope } from '../../../system/trust/context-envelope.js';
import { assessDisclosure } from './decision.js';
import type { DisclosureDestinationConstraint, GenerationDisclosureContext } from './contracts.js';
import { DISCLOSURE_KIND_ID_FIELD } from './contracts.js';
import {
  assertScopedDisclosureConstraints,
  buildGenerationDisclosureLineage,
  memoryDisclosureContribution,
  sessionHistoryDisclosureContribution,
  type DisclosureMemorySource,
} from './generation-lineage.js';

const CONTEXT: GenerationDisclosureContext = {
  generationContextRef: 'turn:test',
  classifierVersion: 'disclosure/v1',
  classifiedAt: '2026-07-19T00:00:00.000Z',
};

const DM_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'private',
  audienceScope: 'one',
  audienceKnowledge: 'all_known',
  broadcast: false,
};
const INVITE_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'invite_only',
  audienceScope: 'few',
  audienceKnowledge: 'partially_known',
  broadcast: false,
};
const PUBLIC_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'public',
  audienceScope: 'many',
  audienceKnowledge: 'anonymous',
  broadcast: false,
};

/** Assert no admitted constraint is an unscoped id-bearing constraint. */
function expectAllScoped(constraints: readonly DisclosureDestinationConstraint[]): void {
  for (const constraint of constraints) {
    const field = DISCLOSURE_KIND_ID_FIELD[constraint.kind];
    if (field === null) continue;
    const ids = field === 'channelId' ? constraint.channelIds : constraint.contactIds;
    expect(ids && ids.length > 0).toBe(true);
  }
}

// ── Population seam: session history (§9.2 item 1) ─────────────────────────────

describe('sessionHistoryDisclosureContribution', () => {
  it('maps a DM scope to its contact and a scoped contact_dm destination', () => {
    const scope = createDmConversationScope({
      channelId: 'discord:dm-1',
      contact: { contactId: 'c1' },
      envelope: DM_ENVELOPE,
    });
    const contribution = sessionHistoryDisclosureContribution(scope);
    expect(contribution.ref).toBe('session:dm:c1');
    expect(contribution.sensitivity).toBe('confidential'); // private ceiling
    expect(contribution.subjectContactIds).toEqual(['c1']);
    expect(contribution.sourceChannelId).toBe('discord:dm-1');
    expect(contribution.permittedDestinations).toEqual([{ kind: 'contact_dm', contactIds: ['c1'] }]);
    expect(contribution.classified).toBe(true);
    expectAllScoped(contribution.permittedDestinations);
  });

  it('maps an invite-only room scope to a scoped invite_only_room destination', () => {
    const scope = createGroupConversationScope({ channelId: 'discord:room-9', envelope: INVITE_ENVELOPE });
    const contribution = sessionHistoryDisclosureContribution(scope);
    expect(contribution.sensitivity).toBe('personal'); // invite_only ceiling
    expect(contribution.subjectContactIds).toEqual([]);
    expect(contribution.permittedDestinations).toEqual([{ kind: 'invite_only_room', channelIds: ['discord:room-9'] }]);
    expectAllScoped(contribution.permittedDestinations);
  });

  it('maps a public room scope to a scoped public_room destination', () => {
    const scope = createGroupConversationScope({ channelId: 'discord:town-square', envelope: PUBLIC_ENVELOPE });
    const contribution = sessionHistoryDisclosureContribution(scope);
    expect(contribution.sensitivity).toBe('public');
    expect(contribution.permittedDestinations).toEqual([{ kind: 'public_room', channelIds: ['discord:town-square'] }]);
    expectAllScoped(contribution.permittedDestinations);
  });

  it('fails closed to companion-self only for a private group (no outward destination)', () => {
    const scope = createGroupConversationScope({
      channelId: 'internal:free-time',
      envelope: DM_ENVELOPE, // private, non-broadcast
    });
    const contribution = sessionHistoryDisclosureContribution(scope);
    expect(contribution.permittedDestinations).toEqual([]);
  });
});

// ── Population seam: memory retrieval (§9.2 item 2) ────────────────────────────

describe('memoryDisclosureContribution', () => {
  it('permits return to the subject contact DM and carries the subject', () => {
    const contribution = memoryDisclosureContribution({
      ref: 'memory:m1',
      sensitivity: 'intimate',
      subjectContactId: 'c7',
    });
    expect(contribution.subjectContactIds).toEqual(['c7']);
    expect(contribution.permittedDestinations).toEqual([{ kind: 'contact_dm', contactIds: ['c7'] }]);
    expectAllScoped(contribution.permittedDestinations);
  });

  it('permits the source room when the memory sits within that channel ceiling', () => {
    // 'discord:room-x' classifies invite_only (default) → ceiling personal.
    const contribution = memoryDisclosureContribution({
      ref: 'memory:m2',
      sensitivity: 'personal',
      sourceChannelId: 'discord:room-x',
    });
    expect(contribution.permittedDestinations).toEqual([{ kind: 'invite_only_room', channelIds: ['discord:room-x'] }]);
    expectAllScoped(contribution.permittedDestinations);
  });

  it('drops the source room when the memory exceeds the channel ceiling', () => {
    // confidential > invite_only ceiling (personal) → no room, no subject → empty.
    const contribution = memoryDisclosureContribution({
      ref: 'memory:m3',
      sensitivity: 'confidential',
      sourceChannelId: 'discord:room-x',
    });
    expect(contribution.permittedDestinations).toEqual([]);
  });

  it('never derives a room from a private source channel', () => {
    // 'api:' is a private prefix → private channel → no outward room.
    const contribution = memoryDisclosureContribution({
      ref: 'memory:m4',
      sensitivity: 'public',
      sourceChannelId: 'api:session-1',
    });
    expect(contribution.permittedDestinations).toEqual([]);
  });

  it('fails closed to companion-self only for a subjectless, channelless memory', () => {
    const contribution = memoryDisclosureContribution({ ref: 'memory:m5', sensitivity: 'public' });
    expect(contribution.permittedDestinations).toEqual([]);
    expect(contribution.subjectContactIds).toEqual([]);
  });
});

// ── Unscoped-id-bearing guard (jp36.1.1.1 review handoff) ──────────────────────

describe('assertScopedDisclosureConstraints', () => {
  it('throws when an id-bearing kind is emitted with no id set', () => {
    expect(() => assertScopedDisclosureConstraints([{ kind: 'contact_dm' }], 'x')).toThrow(/unscoped contact_dm/);
    expect(() => assertScopedDisclosureConstraints([{ kind: 'invite_only_room' }], 'x')).toThrow(/unscoped invite_only_room/);
  });

  it('throws when an id-bearing kind is emitted with an empty id set', () => {
    expect(() => assertScopedDisclosureConstraints([{ kind: 'contact_dm', contactIds: [] }], 'x'))
      .toThrow(/unscoped contact_dm/);
  });

  it('accepts scoped id-bearing kinds and non-id-bearing kinds', () => {
    expect(() => assertScopedDisclosureConstraints([
      { kind: 'contact_dm', contactIds: ['c1'] },
      { kind: 'public_room', channelIds: ['r1'] },
      { kind: 'publication' },
    ], 'x')).not.toThrow();
  });
});

// ── Acceptance: a restricted retrieved memory tightens the accumulator ─────────

describe('buildGenerationDisclosureLineage', () => {
  it('tightens the accumulator when a restricted memory is retrieved (acceptance)', () => {
    const scope = createGroupConversationScope({ channelId: 'discord:town-square', envelope: PUBLIC_ENVELOPE });

    // Baseline: public-room session alone is auto-shareable to that room.
    const baseline = buildGenerationDisclosureLineage({ context: CONTEXT, conversationScope: scope, memorySources: [] });
    expect(baseline.effectiveSensitivity).toBe('public');
    expect(assessDisclosure(baseline, { kind: 'public_room', channelId: 'discord:town-square' }).allowed).toBe(true);

    // Retrieving an intimate memory about an unrelated contact tightens sensitivity
    // and intersects the public room away.
    const restrictedMemory: DisclosureMemorySource = {
      ref: 'memory:intimate-1',
      sensitivity: 'intimate',
      subjectContactId: 'c9',
    };
    const tightened = buildGenerationDisclosureLineage({
      context: CONTEXT,
      conversationScope: scope,
      memorySources: [restrictedMemory],
    });

    expect(tightened.sourceCount).toBe(2);
    expect(tightened.effectiveSensitivity).toBe('intimate');
    expect(tightened.permittedDestinations).toEqual([]);
    expect(tightened.subjectContactIds).toEqual(['c9']);
    expect(assessDisclosure(tightened, { kind: 'public_room', channelId: 'discord:town-square' })).toMatchObject({
      allowed: false,
      outcome: 'non_shareable',
    });
    // companion-self remains the always-eligible private sink.
    expect(assessDisclosure(tightened, { kind: 'companion_self' }).allowed).toBe(true);
    // The accumulated lineage never carries an unscoped id-bearing constraint.
    expectAllScoped(tightened.permittedDestinations);
  });

  it('keeps a same-contact DM shareable when the retrieved memory is about that contact', () => {
    const scope = createDmConversationScope({
      channelId: 'discord:dm-c1',
      contact: { contactId: 'c1' },
      envelope: DM_ENVELOPE,
    });
    const memory: DisclosureMemorySource = { ref: 'memory:m-c1', sensitivity: 'personal', subjectContactId: 'c1' };
    const lineage = buildGenerationDisclosureLineage({ context: CONTEXT, conversationScope: scope, memorySources: [memory] });
    expect(lineage.permittedDestinations).toEqual([{ kind: 'contact_dm', contactIds: ['c1'] }]);
    expect(assessDisclosure(lineage, { kind: 'contact_dm', contactId: 'c1' }).allowed).toBe(true);
    // A different contact's DM is not permitted.
    expect(assessDisclosure(lineage, { kind: 'contact_dm', contactId: 'c2' }).allowed).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  canonicalContactLifecycleSnapshotJson,
  parseContactLifecycleLockedSnapshot,
  parseContactLifecyclePrepareOutcome,
} from './contact-lifecycle-ledger.js';

const verifiedOwnership = {
  schemaVersion: 1 as const,
  contactId: 'contact-a',
  channel: 'discord' as const,
  providerSubjectId: '12345678901234567',
  identityVersion: 3,
  verificationId: '0190f3b4-8f50-7b30-8e24-52f6b3521942',
  verificationDigest: 'a'.repeat(64),
  contactAuthorityVersion: 4,
  ownershipState: 'verified' as const,
  restoreState: 'live' as const,
};

describe('companion contact lifecycle ledger v1 contract', () => {
  it('accepts exact live verified ownership snapshots and canonicalizes them', () => {
    const snapshot = parseContactLifecycleLockedSnapshot({
      schemaVersion: 1,
      contacts: [{
        schemaVersion: 1,
        contactId: 'contact-a',
        contactAuthorityVersion: 4,
        lifecycleState: 'live',
        restoreState: 'live',
      }],
      verifiedOwnerships: [verifiedOwnership],
    });
    expect(JSON.parse(canonicalContactLifecycleSnapshotJson(snapshot))).toEqual(snapshot);
  });

  it('accepts an exact quarantined ownership snapshot only for restored-contact reapproval', () => {
    expect(parseContactLifecycleLockedSnapshot({
      schemaVersion: 1,
      contacts: [{
        schemaVersion: 1,
        contactId: 'contact-a',
        contactAuthorityVersion: 4,
        lifecycleState: 'quarantined',
        restoreState: 'quarantined',
      }],
      verifiedOwnerships: [{
        ...verifiedOwnership,
        ownershipState: 'quarantined',
        restoreState: 'quarantined',
      }],
    })).toMatchObject({
      contacts: [{ lifecycleState: 'quarantined', restoreState: 'quarantined' }],
      verifiedOwnerships: [{ ownershipState: 'quarantined', restoreState: 'quarantined' }],
    });
  });

  it.each([
    { ...verifiedOwnership, ownershipState: 'unverified' },
    { ...verifiedOwnership, ownershipState: 'deleted' },
    { ...verifiedOwnership, restoreState: 'quarantined' },
    { ...verifiedOwnership, identityVersion: 0 },
    { ...verifiedOwnership, contactAuthorityVersion: 1.5 },
    { ...verifiedOwnership, verificationDigest: 'not-a-digest' },
    { ...verifiedOwnership, username: 'name-is-not-authority' },
  ])('rejects non-authoritative or malformed ownership %#', (ownership) => {
    expect(() => parseContactLifecycleLockedSnapshot({
      schemaVersion: 1,
      contacts: [{
        schemaVersion: 1,
        contactId: 'contact-a',
        contactAuthorityVersion: 4,
        lifecycleState: 'live',
        restoreState: 'live',
      }],
      verifiedOwnerships: [ownership],
    })).toThrow(/Invalid companion contact lifecycle ledger v1/);
  });

  it('rejects deleted/restored contacts and companion identity claims', () => {
    for (const contact of [
      {
        schemaVersion: 1,
        contactId: 'contact-a',
        contactAuthorityVersion: 4,
        lifecycleState: 'deleted',
        restoreState: 'live',
      },
      {
        schemaVersion: 1,
        contactId: 'contact-a',
        contactAuthorityVersion: 4,
        lifecycleState: 'live',
        restoreState: 'quarantined',
      },
      {
        schemaVersion: 1,
        contactId: 'contact-a',
        contactAuthorityVersion: 4,
        lifecycleState: 'live',
        restoreState: 'live',
        companionId: 'cross-companion-claim',
      },
    ]) {
      expect(() => parseContactLifecycleLockedSnapshot({
        schemaVersion: 1,
        contacts: [contact],
        verifiedOwnerships: [],
      })).toThrow(/Invalid companion contact lifecycle ledger v1/);
    }
  });

  it('strictly parses visible pending and manual-hold outcomes', () => {
    expect(parseContactLifecyclePrepareOutcome({
      schemaVersion: 1,
      status: 'pending',
      intentId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      phase: 'gateway_prepare_pending',
      reason: 'gateway_prepare_pending',
      snapshotDigest: 'b'.repeat(64),
    }).status).toBe('pending');
    expect(parseContactLifecyclePrepareOutcome({
      schemaVersion: 1,
      status: 'manual_hold',
      intentId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      phase: 'manual_hold',
      reason: 'ownership_quarantined',
    }).status).toBe('manual_hold');
    expect(() => parseContactLifecyclePrepareOutcome({
      schemaVersion: 1,
      status: 'pending',
      intentId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      phase: 'gateway_prepare_pending',
      reason: 'gateway_prepare_pending',
      snapshotDigest: 'b'.repeat(64),
      companionId: 'spoofed',
    })).toThrow(/unknown keys/);
  });
});

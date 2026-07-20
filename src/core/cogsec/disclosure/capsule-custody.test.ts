// jp36.7.1.2 — durable Share Capsule custody + approval-queue-riding service.
//
// Regression-first battery for the custody obligations from the jp36.7.1.1 gate:
// candidate → approval → capsule mint on the EXISTING approval queue, monotonic
// use-count that survives restart, revocation that wins immediately, a capsule
// tampered at rest rejected via parse, and no caller/model surface able to
// inject the prior use-count.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmationQueue } from '../../../system/capabilities/confirmation-queue.js';
import { createApprovalQueuePortFromConfirmationQueue } from '../../../system/capabilities/approval-queue-port.js';
import {
  approveShareCandidate,
  buildShareCandidate,
  type ApprovedShareCapsule,
  type CapsuleExpiry,
  type ShareCandidate,
  type ShareContent,
} from './capsule.js';
import type { DisclosureDestination } from './contracts.js';
import {
  createCapsuleCustodyService,
  createShareCapsuleCustodyStore,
  type ShareCapsuleCustodyStore,
} from './capsule-custody.js';

const NOW = 1_750_000_000_000;
const CONTACT_DESTINATION: DisclosureDestination = { kind: 'contact_dm', contactId: 'contact-1' };
const PUBLICATION_DESTINATION: DisclosureDestination = { kind: 'publication' };
const EXACT_CONTENT: ShareContent = { body: 'An honest, exact sentence.', mediaRefs: ['media:a', 'media:b'] };

function candidate(overrides: Partial<Parameters<typeof buildShareCandidate>[0]> = {}): ShareCandidate {
  return buildShareCandidate({
    candidateId: 'cand-1',
    content: EXACT_CONTENT,
    proposedDestinations: [{ kind: 'contact_dm', contactIds: ['contact-1'] }],
    effectiveSensitivity: 'intimate',
    provenanceRefs: ['memory:1', 'session:x'],
    subjectContactIds: ['contact-1'],
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  });
}

function capsule(
  expiry: CapsuleExpiry = { expiresAt: '2100-01-01T00:00:00.000Z', maxUseCount: 3 },
  cand: ShareCandidate = candidate(),
  capsuleId = 'cap-1',
): ApprovedShareCapsule {
  return approveShareCandidate(cand, {
    capsuleId,
    actor: 'operator:pierre',
    approvedAt: new Date(NOW).toISOString(),
    expiry,
  });
}

describe('ShareCapsuleCustodyStore — durable state', () => {
  let dir: string;
  let filePath: string;
  let store: ShareCapsuleCustodyStore;

  const makeStore = (maxActiveCapsules = 3) =>
    createShareCapsuleCustodyStore(filePath, { maxActiveCapsules, now: () => NOW });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-capsule-custody-'));
    filePath = join(dir, 'cogsec-share-capsules.json');
    store = makeStore();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a minted capsule and round-trips its state with useCount 0', () => {
    const cap = capsule();
    const record = store.putApprovedCapsule(cap);
    expect(record.useCount).toBe(0);
    expect(store.getCapsuleState('cap-1')).toEqual({ capsule: cap, useCount: 0 });
    expect(store.getCapsuleState('missing')).toBeUndefined();
  });

  it('survives a restart: a fresh store instance over the same file sees the capsule and use-count', () => {
    store.putApprovedCapsule(capsule());
    store.recordExactReplayUse({ capsuleId: 'cap-1', expectedPriorUseCount: 0 });
    // "Restart": a brand-new instance over the same on-disk file.
    const rebooted = makeStore();
    expect(rebooted.getCapsuleState('cap-1')?.useCount).toBe(1);
  });

  it('increments the use-count monotonically and refuses a stale expected-prior (CAS)', () => {
    store.putApprovedCapsule(capsule());
    expect(store.recordExactReplayUse({ capsuleId: 'cap-1', expectedPriorUseCount: 0 }).useCount).toBe(1);
    expect(store.recordExactReplayUse({ capsuleId: 'cap-1', expectedPriorUseCount: 1 }).useCount).toBe(2);
    // A caller that thinks the count is still 0 is a lost-update race — fail closed.
    expect(() => store.recordExactReplayUse({ capsuleId: 'cap-1', expectedPriorUseCount: 0 })).toThrow(/concurrent use/);
  });

  it('refuses to record use past the cap and on a revoked capsule', () => {
    store.putApprovedCapsule(capsule({ maxUseCount: 1 }));
    store.recordExactReplayUse({ capsuleId: 'cap-1', expectedPriorUseCount: 0 });
    expect(() => store.recordExactReplayUse({ capsuleId: 'cap-1', expectedPriorUseCount: 1 })).toThrow(/cap of 1/);

    store.putApprovedCapsule(capsule({ maxUseCount: 2 }, candidate(), 'cap-2'));
    store.revokeCapsule({ capsuleId: 'cap-2', revokedAt: new Date(NOW).toISOString() });
    expect(() => store.recordExactReplayUse({ capsuleId: 'cap-2', expectedPriorUseCount: 0 })).toThrow(/revoked/);
  });

  it('revocation is persisted, wins, and is idempotent', () => {
    store.putApprovedCapsule(capsule());
    const revoked = store.revokeCapsule({ capsuleId: 'cap-1', revokedAt: new Date(NOW).toISOString(), reason: 'subject withdrew consent' });
    expect(revoked.revocation).toEqual({ revoked: true, revokedAt: new Date(NOW).toISOString(), reason: 'subject withdrew consent' });
    // Persisted across a restart.
    expect(makeStore().getCapsuleState('cap-1')?.capsule.revocation.revoked).toBe(true);
    // Idempotent: re-revoking keeps the original revocation.
    const again = store.revokeCapsule({ capsuleId: 'cap-1', revokedAt: '2099-01-01T00:00:00.000Z' });
    expect(again.revocation).toMatchObject({ revoked: true, revokedAt: new Date(NOW).toISOString() });
  });

  it('enforces the active-capsule cap at mint', () => {
    const small = makeStore(2);
    small.putApprovedCapsule(capsule({ maxUseCount: 3 }, candidate(), 'cap-1'));
    small.putApprovedCapsule(capsule({ maxUseCount: 3 }, candidate(), 'cap-2'));
    expect(() => small.putApprovedCapsule(capsule({ maxUseCount: 3 }, candidate(), 'cap-3'))).toThrow(/cap reached/);
    // A revoked capsule no longer counts as active — room frees up.
    small.revokeCapsule({ capsuleId: 'cap-1', revokedAt: new Date(NOW).toISOString() });
    expect(() => small.putApprovedCapsule(capsule({ maxUseCount: 3 }, candidate(), 'cap-3'))).not.toThrow();
  });

  it('rejects a duplicate capsule id', () => {
    store.putApprovedCapsule(capsule());
    expect(() => store.putApprovedCapsule(capsule())).toThrow(/already holds/);
  });

  describe('fail-closed load (tamper at rest)', () => {
    const writeRaw = (records: unknown[]) =>
      writeFileSync(filePath, JSON.stringify({ version: 1, entries: records }), 'utf8');

    it('rejects a capsule whose content was edited but hash left stale', () => {
      store.putApprovedCapsule(capsule());
      const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { entries: Array<{ capsule: { content: { body: string } } }> };
      onDisk.entries[0].capsule.content.body = 'silently swapped content';
      writeFileSync(filePath, JSON.stringify(onDisk), 'utf8');
      expect(() => makeStore().list()).toThrow(/tampered at rest|contract/i);
    });

    it('rejects a capsule with a flipped authority literal', () => {
      const cap = JSON.parse(JSON.stringify(capsule())) as Record<string, unknown>;
      cap.authority = 'generative_input';
      writeRaw([{ capsuleId: 'cap-1', capsule: cap, useCount: 0, mintedAtMs: NOW }]);
      expect(() => makeStore().list()).toThrow(/contract/i);
    });

    it('rejects a mismatched record id, an over-cap use-count, and unknown keys', () => {
      const cap = JSON.parse(JSON.stringify(capsule({ maxUseCount: 2 }))) as Record<string, unknown>;
      writeRaw([{ capsuleId: 'wrong-id', capsule: cap, useCount: 0, mintedAtMs: NOW }]);
      expect(() => makeStore().list()).toThrow(/does not match/);

      writeRaw([{ capsuleId: 'cap-1', capsule: cap, useCount: 5, mintedAtMs: NOW }]);
      expect(() => makeStore().list()).toThrow(/exceeds its cap/);

      writeRaw([{ capsuleId: 'cap-1', capsule: cap, useCount: 0, mintedAtMs: NOW, injected: true }]);
      expect(() => makeStore().list()).toThrow(/unsupported keys/);
    });

    it('rejects an unsupported file shape', () => {
      writeFileSync(filePath, JSON.stringify({ version: 2, entries: [] }), 'utf8');
      expect(() => makeStore().list()).toThrow(/Unsupported/);
    });
  });
});

describe('CapsuleCustodyService — rides the existing approval queue', () => {
  let dir: string;
  let filePath: string;
  let clock: number;

  const makeStore = () => createShareCapsuleCustodyStore(filePath, { now: () => clock });
  const makeService = (store: ShareCapsuleCustodyStore) => {
    const queue = new ConfirmationQueue({ now: () => clock, idFactory: () => 'entry-1' });
    const service = createCapsuleCustodyService({
      store,
      approvalQueue: createApprovalQueuePortFromConfirmationQueue(queue),
      now: () => clock,
      capsuleIdFactory: () => 'cap-1',
    });
    return { queue, service };
  };

  const propose = (service: ReturnType<typeof makeService>['service'], expiry: CapsuleExpiry = { maxUseCount: 3 }) =>
    service.proposeShareCandidate({
      candidate: candidate(),
      proposedExpiry: expiry,
      companionReason: 'I want to share this reflection with contact-1.',
      approvalScope: 'contact_dm:contact-1',
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-capsule-service-'));
    filePath = join(dir, 'cogsec-share-capsules.json');
    clock = NOW;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mints and persists an ApprovedShareCapsule only after operator approval on the queue', async () => {
    const store = makeStore();
    const { queue, service } = makeService(store);
    const entry = propose(service);
    // Not yet approved — nothing minted.
    expect(store.getCapsuleState('cap-1')).toBeUndefined();
    expect(entry.method).toBe('share.capsule');

    const result = await queue.resolve({ id: entry.id, decision: 'approve' }, { kind: 'operator', id: 'pierre' });
    expect(result.status).toBe('approved');
    const state = store.getCapsuleState('cap-1');
    expect(state?.useCount).toBe(0);
    expect(state?.capsule.approval.actor).toBe('operator:pierre');
    // The minted capsule binds to the exact proposed content.
    expect(state?.capsule.contentHash).toBe(candidate().contentHash);
  });

  it('refuses an operator attempt to edit the proposed content (approval binds exact)', async () => {
    const store = makeStore();
    const { queue, service } = makeService(store);
    const entry = propose(service);
    const result = await queue.resolve(
      { id: entry.id, decision: 'modify', modifiedParams: { candidateId: 'cand-1', tampered: true } },
      { kind: 'operator', id: 'pierre' },
    );
    expect(result.status).toBe('failed');
    expect(store.getCapsuleState('cap-1')).toBeUndefined();
  });

  it('authorizes exact replay and durably consumes one monotonic use per authorization', async () => {
    const store = makeStore();
    const { queue, service } = makeService(store);
    const entry = propose(service, { maxUseCount: 3 });
    await queue.resolve({ id: entry.id, decision: 'approve' }, { kind: 'operator', id: 'pierre' });

    const replay = () => service.authorizeReplay({
      capsuleId: 'cap-1',
      content: EXACT_CONTENT,
      destination: CONTACT_DESTINATION,
      now: new Date(clock).toISOString(),
      currentEffectiveSensitivity: 'intimate',
    });
    expect(replay()).toMatchObject({ authorized: true, useCount: 1 });
    expect(replay()).toMatchObject({ authorized: true, useCount: 2 });
    // Third use hits the cap of 3; the fourth is exhausted — and the count
    // survived nothing being reset by the caller (priorUseCount is never caller-supplied).
    expect(replay()).toMatchObject({ authorized: true, useCount: 3 });
    expect(replay()).toMatchObject({ authorized: false, code: 'use_count_exhausted' });
  });

  it('use-count is monotonic across a restart', async () => {
    const first = makeStore();
    const { queue, service } = makeService(first);
    const entry = propose(service, { maxUseCount: 3 });
    await queue.resolve({ id: entry.id, decision: 'approve' }, { kind: 'operator', id: 'pierre' });
    service.authorizeReplay({ capsuleId: 'cap-1', content: EXACT_CONTENT, destination: CONTACT_DESTINATION, now: new Date(clock).toISOString(), currentEffectiveSensitivity: 'intimate' });

    // Restart: new store + service over the same file. The count does not rewind.
    const rebooted = makeStore();
    const { service: service2 } = makeService(rebooted);
    const decision = service2.authorizeReplay({ capsuleId: 'cap-1', content: EXACT_CONTENT, destination: CONTACT_DESTINATION, now: new Date(clock).toISOString(), currentEffectiveSensitivity: 'intimate' });
    expect(decision).toMatchObject({ authorized: true, useCount: 2 });
  });

  it('denies replay after the provenance is reclassified to a more restrictive level', async () => {
    const store = makeStore();
    const { queue, service } = makeService(store);
    const entry = propose(service);
    await queue.resolve({ id: entry.id, decision: 'approve' }, { kind: 'operator', id: 'pierre' });

    const decision = service.authorizeReplay({
      capsuleId: 'cap-1',
      content: EXACT_CONTENT,
      destination: CONTACT_DESTINATION,
      now: new Date(clock).toISOString(),
      // approved at 'intimate'; now the live source is 'confidential' (more restrictive).
      currentEffectiveSensitivity: 'confidential',
    });
    expect(decision).toMatchObject({ authorized: false, code: 'source_reclassified' });
    // Denied replay must not have consumed a use.
    expect(store.getCapsuleState('cap-1')?.useCount).toBe(0);
  });

  it('passes through the pure deny codes and never consumes a use on denial', async () => {
    const store = makeStore();
    const { queue, service } = makeService(store);
    const entry = propose(service);
    await queue.resolve({ id: entry.id, decision: 'approve' }, { kind: 'operator', id: 'pierre' });

    const base = { capsuleId: 'cap-1', now: new Date(clock).toISOString(), currentEffectiveSensitivity: 'intimate' as const };
    expect(service.authorizeReplay({ ...base, content: { body: 'edited', mediaRefs: [] }, destination: CONTACT_DESTINATION }))
      .toMatchObject({ authorized: false, code: 'content_hash_mismatch' });
    expect(service.authorizeReplay({ ...base, content: EXACT_CONTENT, destination: PUBLICATION_DESTINATION }))
      .toMatchObject({ authorized: false, code: 'destination_not_permitted' });
    expect(service.authorizeReplay({ capsuleId: 'absent', content: EXACT_CONTENT, destination: CONTACT_DESTINATION, now: base.now, currentEffectiveSensitivity: 'intimate' }))
      .toMatchObject({ authorized: false, code: 'capsule_not_found' });
    expect(store.getCapsuleState('cap-1')?.useCount).toBe(0);
  });

  it('revocation wins immediately at the replay seam', async () => {
    const store = makeStore();
    const { queue, service } = makeService(store);
    const entry = propose(service);
    await queue.resolve({ id: entry.id, decision: 'approve' }, { kind: 'operator', id: 'pierre' });
    service.revokeCapsule({ capsuleId: 'cap-1', revokedAt: new Date(clock).toISOString(), reason: 'operator kill-switch' });

    const decision = service.authorizeReplay({
      capsuleId: 'cap-1',
      content: EXACT_CONTENT,
      destination: CONTACT_DESTINATION,
      now: new Date(clock).toISOString(),
      currentEffectiveSensitivity: 'intimate',
    });
    expect(decision).toMatchObject({ authorized: false, code: 'revoked' });
  });
});

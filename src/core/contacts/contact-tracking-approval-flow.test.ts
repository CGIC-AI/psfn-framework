// ── E3.4 contact-tracking policy gate: approval-flow integration ──
// AC1: approval-mode room — a new speaker triggers a durable queue entry plus
// an operator notification, creates zero contact rows until approval, and
// resolves normally after approval through the standard upsert path.
// AC3-adjacent: auto rooms with the gate wired behave identically to no gate.
// AC4: role_gated fails closed at use with a clear error.
// AC5: the Garden pending-contacts service drives approve/deny/reset.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { resolveAuthorContext } from '../agent/substrate-agent/runtime-context.js';
import { createAdminPendingContactsService } from '../../operator/garden/services/pending-contacts-service.js';
import { createSQLiteContactStore } from './sqlite-adapter.js';
import type { ContactStorePort } from './contact-store-port.js';
import {
  createFilePendingContactApprovalStore,
  type PendingContactApprovalStore,
} from './pending-contact-approvals.js';
import { createContactTrackingGate, type ContactTrackingGate } from './tracking-gate.js';

const PRIMARY_USER_ID = 'discord-primary-user';
const APPROVAL_CHANNEL = 'discord:big-room';
const AUTO_CHANNEL = 'discord:friends-room';
const ROLE_GATED_CHANNEL = 'discord:reserved-room';

const LOGGER = { warn: vi.fn(), debug: vi.fn() };

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: APPROVAL_CHANNEL,
    channelType: 'discord',
    authorId: 'stranger-42',
    authorName: 'vtubegooner69',
    content: 'first message in the big room',
    timestamp: new Date('2026-06-01T12:00:00Z'),
    ...overrides,
  };
}

describe('contact-tracking approval flow (E3.4)', () => {
  let db: Database.Database;
  let contactStore: ContactStorePort;
  let tempDir: string;
  let pendingApprovals: PendingContactApprovalStore;
  let notify: ReturnType<typeof vi.fn>;
  let gate: ContactTrackingGate;

  beforeEach(() => {
    db = new Database(':memory:');
    contactStore = createSQLiteContactStore(db, PRIMARY_USER_ID);
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-approval-flow-'));
    pendingApprovals = createFilePendingContactApprovalStore(join(tempDir, 'pending-approvals.json'));
    notify = vi.fn().mockResolvedValue(undefined);
    gate = createContactTrackingGate({
      channelLabels: {
        [APPROVAL_CHANNEL]: { contactTracking: 'approval' },
        [ROLE_GATED_CHANNEL]: { contactTracking: 'role_gated' },
      },
      pendingApprovals,
      notifyOperatorPendingContact: notify,
      logger: LOGGER,
    });
    LOGGER.warn.mockClear();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    db.close();
  });

  async function resolveWithGate(message: SubstrateMessage) {
    return await resolveAuthorContext({
      message,
      contactStore,
      logger: LOGGER,
      companionIdentityKey: 'companion-test',
      companionDisplayName: 'Companion',
      contactTracking: gate,
    });
  }

  it('AC1: a new speaker in an approval room stays untracked, enqueues, and notifies', async () => {
    const authorContext = await resolveWithGate(makeMessage());

    // Untracked: transcript/prefix attribution only.
    expect(authorContext).toMatchObject({
      trustLevel: 'regular',
      speakerRole: 'user',
      resolvedUserName: 'vtubegooner69',
      continuitySubjectKey: 'stranger-42',
      continuityFallbackKeys: [],
    });
    expect(authorContext.canonicalContactKey).toBeUndefined();
    expect(authorContext.relationshipType).toBeUndefined();

    // Zero contact rows (and hence zero profile/social-graph rows keyed to one).
    expect(await contactStore.getByChannelIdentity('discord', 'stranger-42')).toBeUndefined();
    expect((await contactStore.listAll()).map(contact => contact.displayName)).toEqual([]);

    // Durable queue entry with channel-scoped preview + operator notification.
    const entry = await pendingApprovals.getByIdentity('discord', 'stranger-42');
    expect(entry).toMatchObject({
      channel: 'discord',
      channelUserId: 'stranger-42',
      displayName: 'vtubegooner69',
      channelId: APPROVAL_CHANNEL,
      status: 'pending',
    });
    expect(entry?.messagePreviews[0]?.preview).toBe('first message in the big room');
    expect(notify).toHaveBeenCalledTimes(1);

    // A second message keeps the speaker untracked without re-notifying.
    const secondContext = await resolveWithGate(makeMessage({ id: 'msg-2', content: 'still chatting' }));
    expect(secondContext.canonicalContactKey).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await contactStore.listAll())).toHaveLength(0);
  });

  it('AC1/AC5: after operator approval the contact is created via the normal upsert path and resolves normally', async () => {
    await resolveWithGate(makeMessage());
    const entry = await pendingApprovals.getByIdentity('discord', 'stranger-42');

    const service = createAdminPendingContactsService({ pendingApprovals, contactStore });
    const result = await service.approvePendingContact(entry!.id);
    expect(result.ok).toBe(true);

    const contact = await contactStore.getByChannelIdentity('discord', 'stranger-42');
    expect(contact).toBeDefined();
    expect(contact?.displayName).toBe('vtubegooner69');
    expect(contact?.trustLevel).toBe('regular');

    // Queue entry consumed.
    expect((await service.listPendingContactApprovals()).entries).toHaveLength(0);

    // Subsequent messages resolve normally (canonical contact key bound).
    const postApproval = await resolveWithGate(makeMessage({ id: 'msg-3', content: 'hello again' }));
    expect(postApproval.canonicalContactKey).toBe(contact!.id);
    expect(postApproval.trustLevel).toBe('regular');
    expect(postApproval.relationshipType).toBe('stranger');
  });

  it('AC5: deny persists — the speaker stays untracked and is not re-proposed until reset', async () => {
    await resolveWithGate(makeMessage());
    const entry = await pendingApprovals.getByIdentity('discord', 'stranger-42');
    const service = createAdminPendingContactsService({ pendingApprovals, contactStore });

    const denied = await service.denyPendingContact(entry!.id);
    expect(denied.ok).toBe(true);
    notify.mockClear();

    // Further messages: untracked, no contact, no re-enqueue, no notification.
    const context = await resolveWithGate(makeMessage({ id: 'msg-4', content: 'ignored profile-wise' }));
    expect(context.canonicalContactKey).toBeUndefined();
    expect(await contactStore.getByChannelIdentity('discord', 'stranger-42')).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    const persisted = await pendingApprovals.getByIdentity('discord', 'stranger-42');
    expect(persisted?.status).toBe('denied');

    // Operator reset: the record is removed and the next message re-proposes.
    const reset = await service.resetPendingContactDecision(entry!.id);
    expect(reset.ok).toBe(true);
    await resolveWithGate(makeMessage({ id: 'msg-5', content: 'back again' }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await pendingApprovals.getByIdentity('discord', 'stranger-42'))?.status).toBe('pending');
  });

  it('AC5: mutations against unknown entries report not-found', async () => {
    const service = createAdminPendingContactsService({ pendingApprovals, contactStore });
    expect(await service.approvePendingContact('missing')).toEqual({
      ok: false,
      message: 'Pending contact approval not found',
    });
    expect(await service.denyPendingContact('missing')).toEqual({
      ok: false,
      message: 'Pending contact approval not found',
    });
    expect(await service.resetPendingContactDecision('missing')).toEqual({
      ok: false,
      message: 'Pending contact approval not found',
    });
  });

  it('AC6: auto rooms behave identically with and without the gate wired', async () => {
    const withGate = await resolveWithGate(makeMessage({ channelId: AUTO_CHANNEL, id: 'msg-auto-1' }));
    expect(withGate.canonicalContactKey).toBeDefined();
    expect(withGate.resolvedUserName).toBe('vtubegooner69');

    // Fresh identical store without any gate: same observable result shape.
    const bareDb = new Database(':memory:');
    const bareStore = createSQLiteContactStore(bareDb, PRIMARY_USER_ID);
    const withoutGate = await resolveAuthorContext({
      message: makeMessage({ channelId: AUTO_CHANNEL, id: 'msg-auto-1' }),
      contactStore: bareStore,
      logger: LOGGER,
      companionIdentityKey: 'companion-test',
      companionDisplayName: 'Companion',
    });

    expect({ ...withGate, canonicalContactKey: 'normalized', continuitySubjectKey: 'normalized' })
      .toEqual({ ...withoutGate, canonicalContactKey: 'normalized', continuitySubjectKey: 'normalized' });
    expect(await pendingApprovals.list()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    bareDb.close();
  });

  it('AC4: a role_gated room fails closed at use with a clear, unswallowed error', async () => {
    await expect(resolveWithGate(makeMessage({ channelId: ROLE_GATED_CHANNEL })))
      .rejects.toThrow(/role_gated.*reserved.*not implemented/);
    expect(await contactStore.getByChannelIdentity('discord', 'stranger-42')).toBeUndefined();
  });

  it('resolves already-tracked contacts in approval rooms exactly as before', async () => {
    // Pre-existing contact (e.g. approved earlier or created in an auto room).
    const existing = await contactStore.resolveChannelIdentity('discord', 'stranger-42', 'vtubegooner69');

    const context = await resolveWithGate(makeMessage({ id: 'msg-known-1' }));
    expect(context.canonicalContactKey).toBe(existing.id);
    expect(await pendingApprovals.list()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
});

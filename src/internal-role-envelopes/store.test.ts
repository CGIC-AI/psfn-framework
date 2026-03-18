import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveInternalRoleEnvelopeLedgerPath } from '../persistence/layout.js';
import { InternalRoleEnvelopeLedgerStore } from './store.js';

describe('internal role envelope ledger store', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'psfn-internal-role-ledger-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('appends and replays a channel-scoped append-only ledger', () => {
    const store = new InternalRoleEnvelopeLedgerStore(rootDir);
    const channelId = 'discord:dm/primary';
    const envelope = store.appendEnvelope({
      turnId: 'turn-ledger',
      requestId: 'req-ledger',
      sourceMessageId: 'msg-ledger',
      channelId,
      channelType: 'discord',
      canonicalContactId: 'contact-primary',
      createdAt: 1_742_000_100_000,
      transportRole: 'system',
      internalRole: 'outreach_candidate',
      sourceStage: 'post_turn_appraisal',
      visibility: 'companion_private',
      summary: 'Queue a care check-in for tomorrow.',
      body: 'Reach out tomorrow after lunch unless there is a newer inbound reply.',
      tags: ['care_check_in'],
      provenanceRefs: ['turn:turn-ledger'],
      ordinal: 0,
    });
    const promotion = store.appendPromotion(channelId, {
      envelopeId: envelope.envelopeId,
      loggedAt: 1_742_000_100_100,
      status: 'candidate',
      target: 'outreach_handoff',
      reason: 'Eligible for primary-contact DM review',
      promotedRef: 'handoff:oh_1',
    });
    const tombstone = store.appendTombstone(channelId, {
      envelopeId: envelope.envelopeId,
      loggedAt: 1_742_000_100_200,
      action: 'cancel',
      actor: 'operator:test',
      reason: 'Superseded by newer inbound activity',
    });

    const ledgerPath = resolveInternalRoleEnvelopeLedgerPath(rootDir, channelId);
    expect(store.getChannelLedgerPath(channelId)).toBe(ledgerPath);
    expect(readFileSync(ledgerPath, 'utf-8').trim().split('\n')).toHaveLength(3);
    expect(store.readEntries(channelId)).toEqual([
      {
        type: 'envelope',
        loggedAt: envelope.createdAt,
        envelope,
      },
      promotion,
      tombstone,
    ]);
  });
});

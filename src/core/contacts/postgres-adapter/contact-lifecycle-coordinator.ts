import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  contactAuthorityPostStateForAction,
  parseContactAuthorityLifecycleRequest,
  type ContactAuthorityLifecycleRequest,
} from '../../../shared/contracts/contact-authority-lifecycle.js';
import type {
  ContactLifecyclePrepareOutcome,
  ContactLifecycleRecoveryLease,
} from '../../../shared/contracts/contact-lifecycle-ledger.js';
import type { ChannelPrivacyLevel, ContactIdentityLinkVerificationResult } from '../types.js';
import {
  beginContactLifecycleMutationCommit,
  completeContactLifecycleMutationCommit,
  readContactLifecycleCommittedVersion,
} from './contact-lifecycle-mutation-commit.js';
import { withPostgresClient } from './connection.js';
import type { PostgresContactOperationContext, PostgresContactOperationMap, PostgresContactStoreClass } from './operation-map.js';
import type { ContactIdentityVerificationRow } from './rows.js';

export class ContactLifecycleMutationPendingError extends Error {
  constructor(
    readonly outcome: ContactLifecyclePrepareOutcome,
    options?: ErrorOptions,
  ) {
    super(`Contact lifecycle mutation is ${outcome.status}: ${outcome.reason}`, options);
    this.name = 'ContactLifecycleMutationPendingError';
  }
}

function deterministicIntentId(parts: readonly string[]): string {
  const bytes = Buffer.from(createHash('sha256')
    .update(JSON.stringify(['contact-lifecycle-v1', ...parts]))
    .digest('hex')
    .slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function versionToken(value: string | undefined, field: string): string {
  if (value === undefined) return 'missing';
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Corrupt contact lifecycle ${field}`);
  }
  return String(parsed);
}

async function findMatchingLifecycleRequest(
  store: PostgresContactOperationContext,
  input: {
    action: ContactAuthorityLifecycleRequest['action'];
    contactId: string;
    canonicalContactId?: string;
    providerSubjectId?: string;
    phases: readonly string[];
  },
): Promise<Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }> | undefined> {
  const result = await store.pool.query<{ canonical_request: unknown }>(`
    SELECT canonical_request FROM contact_lifecycle_intents
    WHERE action = $1 AND contact_id = $2
      AND canonical_contact_id IS NOT DISTINCT FROM $3::text
      AND provider_subject_id IS NOT DISTINCT FROM $4::text
      AND phase = ANY($5::text[])
      AND restore_state = 'live'
    ORDER BY created_at DESC, intent_id DESC
    LIMIT 1
  `, [
    input.action,
    input.contactId,
    input.canonicalContactId ?? null,
    input.providerSubjectId ?? null,
    [...input.phases],
  ]);
  const value = result.rows.at(0)?.canonical_request;
  if (value === undefined) return undefined;
  const request = parseContactAuthorityLifecycleRequest(value);
  if (request.phase !== 'prepare') {
    throw new Error('Corrupt matching contact lifecycle request phase');
  }
  return request;
}

async function resumeMatchingPendingLifecycle(
  store: PostgresContactOperationContext,
  input: Omit<Parameters<typeof findMatchingLifecycleRequest>[1], 'phases'>,
): Promise<boolean> {
  const request = await findMatchingLifecycleRequest(store, {
    ...input,
    phases: [
      'gateway_prepare_pending',
      'contact_commit_pending',
      'gateway_finalize_pending',
    ],
  });
  if (!request) return false;
  requireCompleted(await driveContactLifecycle(store, request));
  return true;
}

async function matchingLifecycleIsFinalized(
  store: PostgresContactOperationContext,
  input: Omit<Parameters<typeof findMatchingLifecycleRequest>[1], 'phases'>,
): Promise<boolean> {
  return await findMatchingLifecycleRequest(store, { ...input, phases: ['finalized'] }) !== undefined;
}

async function commitIdentityConflict(
  store: PostgresContactOperationContext,
  request: Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }>,
  recoveryLeaseOwner?: string,
): Promise<void> {
  await withPostgresClient(store.pool, async (client: PoolClient) => {
    await beginContactLifecycleMutationCommit(
      client,
      request.intentId,
      'contact.identity_conflict',
      recoveryLeaseOwner,
    );
    const changed = await client.query(`
      UPDATE contact_channel_ids
      SET ownership_state = 'quarantined', restore_state = 'quarantined'
      WHERE contact_id = $1 AND channel = 'discord' AND channel_user_id = $2
        AND ownership_state = 'verified'
    `, [request.contactId, request.providerSubjectId]);
    if (changed.rowCount !== 1) {
      throw new Error('Contact identity conflict ownership changed before local suspension');
    }
    const version = await client.query<{ contact_authority_version: string }>(`
      SELECT contact_authority_version FROM contacts WHERE id = $1
    `, [request.contactId]);
    await completeContactLifecycleMutationCommit(
      client,
      request.intentId,
      Number(version.rows.at(0)?.contact_authority_version),
      recoveryLeaseOwner,
    );
  });
}

async function commitLocalMutation(
  store: PostgresContactOperationContext,
  request: Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }>,
  recoveryLeaseOwner?: string,
): Promise<void> {
  let applied = true;
  if (request.action === 'contact.merge') {
    if (!request.canonicalContactId) {
      throw new Error('Contact merge lifecycle canonical contact is missing');
    }
    applied = await store.mergeContactsDirect(
      request.contactId,
      request.canonicalContactId,
      request.intentId,
      recoveryLeaseOwner,
    );
  } else if (request.action === 'contact.delete') {
    applied = await store.deleteContactDirect(
      request.contactId,
      request.intentId,
      recoveryLeaseOwner,
    );
  } else if (request.action === 'contact.discord_unlink') {
    if (!request.providerSubjectId) {
      throw new Error('Contact unlink lifecycle provider subject is missing');
    }
    applied = await store.unlinkChannelIdentityDirect(
      request.contactId,
      'discord',
      request.providerSubjectId,
      'system:contact-lifecycle',
      request.intentId,
      recoveryLeaseOwner,
    );
  } else if (request.action === 'contact.verify') {
    await store.commitVerifiedDiscordIdentity(
      request.intentId,
      request.intentId,
      recoveryLeaseOwner,
    );
  } else if (request.action === 'contact.reapprove') {
    await store.commitReapprovedDiscordIdentity(request.intentId, recoveryLeaseOwner);
  } else {
    await commitIdentityConflict(store, request, recoveryLeaseOwner);
  }
  if (!applied) throw new Error('Contact lifecycle canonical mutation was rejected');
}

async function driveContactLifecycle(
  store: PostgresContactOperationContext,
  request: Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }>,
  recoveryLeaseOwner?: string,
): Promise<ContactLifecyclePrepareOutcome> {
  const gateway = store.contactLifecycleGateway;
  if (!gateway) {
    throw new Error('Authenticated contact lifecycle gateway is not configured');
  }
  let outcome = await store.prepareContactLifecycleIntent(request);
  for (let step = 0; step < 4 && outcome.status === 'pending'; step += 1) {
    if (outcome.phase === 'gateway_prepare_pending') {
      const result = await gateway.executeContactLifecycle(request);
      outcome = await store.recordContactLifecycleGatewayResult({
        intentId: request.intentId,
        result,
        ...(recoveryLeaseOwner ? { leaseOwner: recoveryLeaseOwner } : {}),
      });
      continue;
    }
    if (outcome.phase === 'contact_commit_pending') {
      await commitLocalMutation(store, request, recoveryLeaseOwner);
      outcome = await store.prepareContactLifecycleIntent(request);
      continue;
    }
    const contactVersion = await readContactLifecycleCommittedVersion(
      store.pool,
      request.intentId,
    );
    const result = await gateway.executeContactLifecycle({
      ...request,
      phase: 'finalize',
      postState: {
        schemaVersion: 1,
        state: contactAuthorityPostStateForAction(request.action),
        contactVersion,
      },
    });
    outcome = await store.recordContactLifecycleGatewayResult({
      intentId: request.intentId,
      result,
      ...(recoveryLeaseOwner ? { leaseOwner: recoveryLeaseOwner } : {}),
    });
  }
  return outcome;
}

function requireCompleted(outcome: ContactLifecyclePrepareOutcome): void {
  if (outcome.status !== 'completed') {
    throw new ContactLifecycleMutationPendingError(outcome);
  }
}

async function driveLease(
  store: PostgresContactOperationContext,
  lease: ContactLifecycleRecoveryLease,
): Promise<ContactLifecyclePrepareOutcome> {
  try {
    return await driveContactLifecycle(store, lease.request, lease.leaseOwner);
  } catch (error) {
    try {
      return await store.deferContactLifecycleRecovery({
        intentId: lease.intentId,
        leaseOwner: lease.leaseOwner,
        reason: 'recovery_failed',
      });
    } catch (deferralError) {
      throw new AggregateError(
        [error, deferralError],
        'Contact lifecycle recovery failed and could not record its deferral',
      );
    }
  }
}

const postgresContactLifecycleCoordinatorOperations: PostgresContactOperationMap = {
  async mergeContacts(sourceContactId: string, targetContactId: string): Promise<boolean> {
    if (!this.contactLifecycleGateway) {
      return await this.mergeContactsDirect(sourceContactId, targetContactId);
    }
    if (sourceContactId === targetContactId) return true;
    const lifecycleTarget = {
      action: 'contact.merge' as const,
      contactId: sourceContactId,
      canonicalContactId: targetContactId,
    };
    if (await resumeMatchingPendingLifecycle(this, lifecycleTarget)) return true;
    const versions = await this.pool.query<{
      id: string;
      contact_authority_version: string;
    }>(`
      SELECT id, contact_authority_version FROM contacts
      WHERE id = ANY($1::text[])
      ORDER BY id
    `, [[sourceContactId, targetContactId]]);
    const byId = new Map(versions.rows.map(row => [row.id, row.contact_authority_version]));
    if (!byId.has(sourceContactId)
      && await matchingLifecycleIsFinalized(this, lifecycleTarget)) return true;
    const request = {
      schemaVersion: 1,
      intentId: deterministicIntentId([
        'merge',
        sourceContactId,
        versionToken(byId.get(sourceContactId), 'merge source version'),
        targetContactId,
        versionToken(byId.get(targetContactId), 'merge target version'),
      ]),
      phase: 'prepare',
      action: 'contact.merge',
      contactId: sourceContactId,
      canonicalContactId: targetContactId,
    } as const;
    requireCompleted(await driveContactLifecycle(this, request));
    return true;
  },

  async deleteContact(id: string): Promise<boolean> {
    if (!this.contactLifecycleGateway) return await this.deleteContactDirect(id);
    const lifecycleTarget = { action: 'contact.delete' as const, contactId: id };
    if (await resumeMatchingPendingLifecycle(this, lifecycleTarget)) return true;
    const version = await this.pool.query<{ contact_authority_version: string }>(`
      SELECT contact_authority_version FROM contacts WHERE id = $1
    `, [id]);
    if (version.rowCount === 0
      && await matchingLifecycleIsFinalized(this, lifecycleTarget)) return true;
    const request = {
      schemaVersion: 1,
      intentId: deterministicIntentId([
        'delete', id, versionToken(version.rows.at(0)?.contact_authority_version, 'delete version'),
      ]),
      phase: 'prepare',
      action: 'contact.delete',
      contactId: id,
    } as const;
    requireCompleted(await driveContactLifecycle(this, request));
    return true;
  },

  async unlinkChannelIdentity(
    contactId: string,
    channel: string,
    channelUserId: string,
    actor?: string,
  ): Promise<boolean> {
    if (!this.contactLifecycleGateway || channel.trim().toLowerCase() !== 'discord') {
      return await this.unlinkChannelIdentityDirect(contactId, channel, channelUserId, actor);
    }
    const providerSubjectId = channelUserId.trim();
    const lifecycleTarget = {
      action: 'contact.discord_unlink' as const,
      contactId,
      providerSubjectId,
    };
    if (await resumeMatchingPendingLifecycle(this, lifecycleTarget)) return true;
    const authority = await this.pool.query<{
      contact_authority_version: string;
      identity_version: string;
      verification_id: string | null;
    }>(`
      SELECT contact.contact_authority_version, ownership.identity_version,
             ownership.verification_id
      FROM contacts AS contact
      JOIN contact_channel_ids AS ownership ON ownership.contact_id = contact.id
      WHERE contact.id = $1 AND ownership.channel = 'discord'
        AND ownership.channel_user_id = $2
    `, [contactId, providerSubjectId]);
    const current = authority.rows.at(0);
    if (!current && await matchingLifecycleIsFinalized(this, lifecycleTarget)) return true;
    const request = {
      schemaVersion: 1,
      intentId: deterministicIntentId([
        'discord-unlink',
        contactId,
        versionToken(current?.contact_authority_version, 'unlink contact version'),
        providerSubjectId,
        versionToken(current?.identity_version, 'unlink identity version'),
        current?.verification_id ?? 'missing',
      ]),
      phase: 'prepare',
      action: 'contact.discord_unlink',
      contactId,
      providerSubjectId,
    } as const;
    requireCompleted(await driveContactLifecycle(this, request));
    return true;
  },

  async reapproveRestoredDiscordIdentity(
    contactId: string,
    channelUserId: string,
  ): Promise<boolean> {
    if (!this.contactLifecycleGateway) {
      throw new Error('Authenticated contact lifecycle gateway is not configured');
    }
    const providerSubjectId = channelUserId.trim();
    const lifecycleTarget = {
      action: 'contact.reapprove' as const,
      contactId,
      providerSubjectId,
    };
    if (await resumeMatchingPendingLifecycle(this, lifecycleTarget)) return true;
    const authority = await this.pool.query<{
      contact_authority_version: string;
      contact_lifecycle_state: string;
      contact_restore_state: string;
      identity_version: string;
      verification_id: string | null;
      ownership_state: string;
      ownership_restore_state: string;
    }>(`
      SELECT contact.contact_authority_version, contact.contact_lifecycle_state,
             contact.contact_restore_state, ownership.identity_version,
             ownership.verification_id, ownership.ownership_state,
             ownership.restore_state AS ownership_restore_state
      FROM contacts AS contact
      JOIN contact_channel_ids AS ownership ON ownership.contact_id = contact.id
      WHERE contact.id = $1 AND ownership.channel = 'discord'
        AND ownership.channel_user_id = $2
    `, [contactId, providerSubjectId]);
    const current = authority.rows.at(0);
    if (current?.contact_lifecycle_state === 'live'
      && current.contact_restore_state === 'live'
      && current.ownership_state === 'verified'
      && current.ownership_restore_state === 'live'
      && await matchingLifecycleIsFinalized(this, lifecycleTarget)) return true;
    const request = {
      schemaVersion: 1,
      intentId: deterministicIntentId([
        'discord-reapprove',
        contactId,
        versionToken(current?.contact_authority_version, 'reapproval contact version'),
        providerSubjectId,
        versionToken(current?.identity_version, 'reapproval identity version'),
        current?.verification_id ?? 'missing',
      ]),
      phase: 'prepare',
      action: 'contact.reapprove',
      contactId,
      providerSubjectId,
    } as const;
    requireCompleted(await driveContactLifecycle(this, request));
    return true;
  },

  async verifyDiscordIdentityLifecycle(
    row: ContactIdentityVerificationRow,
    privacyLevel?: ChannelPrivacyLevel,
  ): Promise<ContactIdentityLinkVerificationResult> {
    const existingOwnership = await this.pool.query<{
      contact_id: string;
      ownership_state: string;
      restore_state: string;
    }>(`
      SELECT contact_id, ownership_state, restore_state
      FROM contact_channel_ids
      WHERE channel = 'discord' AND channel_user_id = $1
    `, [row.target_user_id]);
    const owner = existingOwnership.rows.at(0);
    if (owner && owner.contact_id !== row.contact_id) {
      if (owner.ownership_state === 'verified' && owner.restore_state === 'live') {
        await this.suspendVerifiedDiscordIdentityConflict(
          owner.contact_id,
          row.target_user_id,
          row.id,
        );
      }
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'identity_conflict');
      return {
        status: 'identity_conflict',
        verification: failed ?? this.toVerification(row),
      };
    }
    const contact = await this.getById(row.contact_id);
    if (!contact) return { status: 'contact_not_found' };
    const linkResult = await this.upsertIdentityLinkRecord(
      row.contact_id,
      'discord',
      row.target_user_id,
      contact.firstSeen,
      new Date().toISOString(),
      privacyLevel,
    );
    if (linkResult === 'identity_conflict') {
      throw new Error('Contact verification owner changed during exact link preparation');
    }
    const request = {
      schemaVersion: 1,
      intentId: row.id,
      phase: 'prepare',
      action: 'contact.verify',
      contactId: row.contact_id,
      providerSubjectId: row.target_user_id,
    } as const;
    requireCompleted(await driveContactLifecycle(this, request));
    const verified = await this.pool.query<ContactIdentityVerificationRow>(`
      SELECT * FROM contact_identity_link_verifications WHERE id = $1
    `, [row.id]);
    const finalVerification = verified.rows.at(0);
    if (!finalVerification || finalVerification.status !== 'verified') {
      throw new Error('Finalized contact verification proof is missing');
    }
    const duplicatePrimaryRows = this.primaryUserId === row.target_user_id
      ? await this.pool.query<{ id: string }>(`
          SELECT id FROM contacts
          WHERE id <> $1 AND trust_level = 'primary'
          ORDER BY first_seen, id
        `, [row.contact_id])
      : { rows: [] as Array<{ id: string }> };
    for (const duplicate of duplicatePrimaryRows.rows) {
      await this.mergeContacts(duplicate.id, row.contact_id);
    }
    await this.upsertSocialGraphEntityForContact({
      id: contact.id,
      displayName: contact.displayName,
      firstSeen: contact.firstSeen,
      lastSeen: contact.lastSeen,
    });
    await this.syncContactExports();
    return {
      // A retry can observe the unverified row written by the first attempt.
      // The proof still represents one logical link operation, so preserve its
      // replay-stable public result instead of leaking the recovery boundary.
      status: 'linked',
      verification: this.toVerification(finalVerification),
    };
  },

  async suspendVerifiedDiscordIdentityConflict(
    contactId: string,
    providerSubjectId: string,
    discriminator: string,
  ): Promise<void> {
    const conflict = {
      schemaVersion: 1,
      intentId: deterministicIntentId([
        'identity-conflict', contactId, providerSubjectId, discriminator,
      ]),
      phase: 'prepare',
      action: 'contact.identity_conflict',
      contactId,
      providerSubjectId,
    } as const;
    requireCompleted(await driveContactLifecycle(this, conflict));
  },

  async resumeContactLifecycleIntent(
    request: Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }>,
  ): Promise<ContactLifecyclePrepareOutcome> {
    return await driveContactLifecycle(this, request);
  },

  async recoverContactLifecycleMutations(): Promise<ContactLifecyclePrepareOutcome[]> {
    if (!this.contactLifecycleGateway) return [];
    const leaseOwner = `startup-${randomUUID()}`;
    const leases = await this.claimContactLifecycleRecovery({
      leaseOwner,
      limit: 25,
      leaseMs: 60_000,
    });
    const outcomes: ContactLifecyclePrepareOutcome[] = [];
    for (const lease of leases) outcomes.push(await driveLease(this, lease));
    return outcomes;
  },
};

export function installPostgresContactLifecycleCoordinatorOperations(
  store: PostgresContactStoreClass,
): void {
  Object.assign(store.prototype, postgresContactLifecycleCoordinatorOperations);
}

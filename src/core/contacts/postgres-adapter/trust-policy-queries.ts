import type { Pool, PoolClient } from 'pg';
import type { Contact } from '../types.js';
import type { ContactTrustDriftApplyResult, ContactTrustDriftSuggestion, ContactTrustMutationOptions } from '../contact-store-port.js';
import type { TrustLevel, LowTierTrustLevel } from '../../../system/trust/types.js';
import { isHighTierTrustLevel, isLowTierTrustLevel } from '../../../system/trust/types.js';
import { evaluateLowTierTrustDriftSuggestion, isManualHighTierTrustMutationAuthorized, resolveTrustMutationSource, type TrustDriftBehaviorSignals } from '../../../system/trust/policy.js';
import { isPrimaryIdentity } from '../store/identity-utils.js';
import type { collectUpsertIdentities } from '../store/upsert.js';
import { withPostgresClient } from './connection.js';
import type { PostgresContactOperationMap, PostgresContactStoreClass } from './operation-map.js';
import { compareAndSetExplicitTrust, loadContactTrustSnapshot } from './trust-concurrency.js';

const postgresContactTrustPolicyOperations: PostgresContactOperationMap = {
  async appendPrimaryTrustAudit(
    contactId: string | undefined,
    previousTrustLevel: TrustLevel | null,
    source: 'upsert' | 'set_trust_level',
    outcome: 'allowed' | 'denied',
    actor?: string,
    details?: Record<string, unknown>,
    queryable?: Pool | PoolClient,
  ): Promise<void> {
    const baseActor = actor?.trim() || `system:contact_store:${source}`;
    const auditActor = `${baseActor}:primary_${outcome}`;
    if (contactId) {
      await this.appendMutationAuditEntry(contactId, 'trust_level', previousTrustLevel, 'primary', auditActor, queryable);
    }
    if (outcome === 'denied') {
      console.warn('Denied primary trust mutation', {
        contactId,
        previousTrustLevel,
        actor: baseActor,
        source,
        ...(details ?? {}),
      });
    }
  },

  isPrimaryTrustAssignmentAuthorized(
    contact: Contact | undefined,
    identities: ReturnType<typeof collectUpsertIdentities>,
    discordUserId: string | undefined,
    options: ContactTrustMutationOptions = {},
  ): boolean {
    if (options.allowPrimaryTrustAssignment === true) return true;
    if (!this.primaryUserId) return false;
    const boundCandidates = [
      ...(Array.isArray(contact?.channelIdentities) ? contact.channelIdentities : []),
      ...(contact?.discordUserId ? [{ channel: 'discord', userId: contact.discordUserId }] : []),
    ];
    if (contact) {
      return boundCandidates.some(identity => isPrimaryIdentity(identity, this.primaryUserId));
    }
    const creationCandidates = [
      ...identities,
      ...(discordUserId ? [{ channel: 'discord', userId: discordUserId }] : []),
    ];
    return creationCandidates.some(identity => isPrimaryIdentity(identity, this.primaryUserId));
  },

  async suggestLowTierTrustDrift(
    id: string,
    signals: TrustDriftBehaviorSignals,
    _actor?: string,
  ): Promise<ContactTrustDriftSuggestion | null> {
    const contact = await this.getById(id);
    if (!contact) return null;
    const suggestion = evaluateLowTierTrustDriftSuggestion(contact.trustLevel, signals);
    if (!suggestion) return null;
    return {
      ...suggestion,
      contactId: contact.id,
      createdAt: new Date().toISOString(),
    };
  },

  async applyLowTierTrustDriftSuggestion(
    id: string,
    suggestion: ContactTrustDriftSuggestion,
    actor?: string,
  ): Promise<ContactTrustDriftApplyResult> {
    const contact = await this.getById(id);
    if (!contact) {
      return { applied: false, reason: `Contact ${id} not found` };
    }
    if (suggestion.contactId !== id) {
      return { applied: false, reason: 'Trust drift suggestion contact mismatch' };
    }
    if (!isLowTierTrustLevel(contact.trustLevel)) {
      return { applied: false, reason: 'High-tier trust requires manual-only mutation paths' };
    }
    const currentTrustLevel = contact.trustLevel as LowTierTrustLevel;
    if (suggestion.fromTrustLevel !== currentTrustLevel) {
      return {
        applied: false,
        reason: `Stale trust drift suggestion: expected ${suggestion.fromTrustLevel}, found ${currentTrustLevel}`,
      };
    }
    if (!isLowTierTrustLevel(suggestion.suggestedTrustLevel)) {
      return {
        applied: false,
        reason: 'Trust drift suggestion denied: high-tier trust cannot be set through suggestion flow',
      };
    }
    const applied = await this.setTrustLevel(
      id,
      suggestion.suggestedTrustLevel,
      actor,
      { mutationSource: 'behavior_drift' },
    );
    if (!applied) {
      return { applied: false, reason: 'Trust drift suggestion denied by trust guardrails' };
    }
    return {
      applied: true,
      reason: `Applied low-tier trust drift: ${suggestion.fromTrustLevel} -> ${suggestion.suggestedTrustLevel}`,
    };
  },

  async setTrustLevel(
    id: string,
    trustLevel: TrustLevel,
    actor?: string,
    options: ContactTrustMutationOptions = {},
  ): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    const trustSnapshot = await loadContactTrustSnapshot(this.pool, id);
    if (!trustSnapshot) return false;
    const currentTrustLevel = trustSnapshot.trustLevel;
    if (currentTrustLevel === trustLevel) return true;

    const mutationSource = resolveTrustMutationSource(actor, options.mutationSource);
    if (
      mutationSource === 'behavior_drift'
      && (isHighTierTrustLevel(currentTrustLevel) || isHighTierTrustLevel(trustLevel))
    ) {
      return false;
    }
    if (
      (isHighTierTrustLevel(currentTrustLevel) || isHighTierTrustLevel(trustLevel))
      && !isManualHighTierTrustMutationAuthorized(actor, mutationSource)
    ) {
      return false;
    }
    if (currentTrustLevel === 'primary') {
      return false;
    }
    if (trustLevel === 'primary' && !this.isPrimaryTrustAssignmentAuthorized(contact, [], contact.discordUserId, options)) {
      await this.appendPrimaryTrustAudit(contact.id, currentTrustLevel, 'set_trust_level', 'denied', actor, {
        requestedTrustLevel: trustLevel,
        hasConfiguredPrimaryUserId: Boolean(this.primaryUserId),
      });
      return false;
    }

    const updated = await withPostgresClient(this.pool, async (client) => {
      const changed = await compareAndSetExplicitTrust(client, id, trustSnapshot, trustLevel);
      if (!changed) return false;
      if (trustLevel === 'primary') {
        await this.appendPrimaryTrustAudit(
          id,
          currentTrustLevel,
          'set_trust_level',
          'allowed',
          actor,
          undefined,
          client,
        );
      } else {
        await this.appendMutationAuditEntry(
          id,
          'trust_level',
          currentTrustLevel,
          trustLevel,
          actor,
          client,
        );
      }
      return true;
    });
    if (!updated) return false;
    await this.syncContactExports();
    return true;
  },
};

export function installPostgresContactTrustPolicyOperations(store: PostgresContactStoreClass): void {
  Object.assign(store.prototype, postgresContactTrustPolicyOperations);
}

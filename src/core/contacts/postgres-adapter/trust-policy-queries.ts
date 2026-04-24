import type { Contact } from '../types.js';
import type { ContactTrustDriftApplyResult, ContactTrustDriftSuggestion, ContactTrustMutationOptions } from '../contact-store-port.js';
import type { TrustLevel, LowTierTrustLevel } from '../../../system/trust/types.js';
import { isHighTierTrustLevel, isLowTierTrustLevel } from '../../../system/trust/types.js';
import { evaluateLowTierTrustDriftSuggestion, isManualHighTierTrustMutationAuthorized, resolveTrustMutationSource, type TrustDriftBehaviorSignals } from '../../../system/trust/policy.js';
import { isPrimaryIdentity } from '../store/identity-utils.js';
import type { collectUpsertIdentities } from '../store/upsert.js';
import type { PostgresContactOperationMap } from './operation-map.js';
import type { PostgresContactStore } from './store.js';

const postgresContactTrustPolicyOperations: PostgresContactOperationMap = {
  async appendPrimaryTrustAudit(
    contactId: string | undefined,
    previousTrustLevel: TrustLevel | null,
    source: 'upsert' | 'set_trust_level',
    outcome: 'allowed' | 'denied',
    actor?: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const baseActor = actor?.trim() || `system:contact_store:${source}`;
    const auditActor = `${baseActor}:primary_${outcome}`;
    if (contactId) {
      await this.appendMutationAuditEntry(contactId, 'trust_level', previousTrustLevel, 'primary', auditActor);
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
    if (contact?.discordUserId?.trim() === this.primaryUserId) return true;
    if (discordUserId?.trim() === this.primaryUserId) return true;
    const candidates = [
      ...identities,
      ...(Array.isArray(contact?.channelIdentities) ? contact.channelIdentities : []),
      ...(contact?.discordUserId ? [{ channel: 'discord', userId: contact.discordUserId }] : []),
      ...(discordUserId ? [{ channel: 'discord', userId: discordUserId }] : []),
    ];
    return candidates.some(identity => isPrimaryIdentity(identity, this.primaryUserId));
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
    if (contact.trustLevel === trustLevel) return true;

    const mutationSource = resolveTrustMutationSource(actor, options.mutationSource);
    if (
      mutationSource === 'behavior_drift'
      && isHighTierTrustLevel(contact.trustLevel)
    ) {
      return false;
    }
    if (
      mutationSource === 'behavior_drift'
      && isHighTierTrustLevel(trustLevel)
      && !isManualHighTierTrustMutationAuthorized(actor, mutationSource)
    ) {
      return false;
    }
    if (contact.trustLevel === 'primary') {
      return false;
    }
    if (trustLevel === 'primary' && !this.isPrimaryTrustAssignmentAuthorized(contact, [], contact.discordUserId, options)) {
      await this.appendPrimaryTrustAudit(contact.id, contact.trustLevel, 'set_trust_level', 'denied', actor, {
        requestedTrustLevel: trustLevel,
        hasConfiguredPrimaryUserId: Boolean(this.primaryUserId),
      });
      return false;
    }

    await this.pool.query('UPDATE contacts SET trust_level = $1 WHERE id = $2', [trustLevel, id]);
    if (trustLevel === 'primary') {
      await this.appendPrimaryTrustAudit(id, contact.trustLevel, 'set_trust_level', 'allowed', actor);
    } else {
      await this.appendMutationAuditEntry(id, 'trust_level', contact.trustLevel, trustLevel, actor);
    }
    await this.syncContactExports();
    return true;
  },
};

export function installPostgresContactTrustPolicyOperations(store: typeof PostgresContactStore): void {
  Object.assign(store.prototype, postgresContactTrustPolicyOperations);
}

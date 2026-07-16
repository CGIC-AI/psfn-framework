import { randomUUID } from 'node:crypto';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import type {
  DiscordEvidenceAuthorityChange,
  DiscordEvidenceLifecycleEventSourcePort,
  DiscordEvidenceLifecycleMutation,
  DiscordEvidenceStorePort,
} from './discord-evidence-types.js';
import {
  parseProviderMembershipEvidence,
  type DiscordEvidenceRuntime,
  type ProviderMembershipObservation,
} from './discord-evidence-runtime.js';

export type DiscordEvidenceReauthenticationReason =
  | 'evidence_expired'
  | 'provider_evidence_unavailable'
  | 'provider_evidence_invalid'
  | 'session_expired';

interface ActiveMembershipEvidence {
  principalId: string;
  providerSubjectId: string;
  lifecycleId: string;
  generation: number;
  providerMembershipEvidence: {
    status: 'observed';
    providerSubjectId: string;
    observedAt: string;
    guilds: Array<{ guildId: string; roleIds: string[] }>;
  };
  providerExpiresAt: Date;
  sessionExpiresAt: Date;
  renewalAttempted: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface DiscordEvidenceLifecycleOptions {
  config: FleetAuthConfig;
  runtime: Pick<DiscordEvidenceRuntime, 'refreshPrincipalEvidence' | 'refreshCompanionEvidence'>;
  store: Pick<
    DiscordEvidenceStorePort,
    | 'activatePrincipalEvidenceLifecycle'
    | 'invalidatePrincipalEvidence'
    | 'revokeAllEvidence'
    | 'revokePrincipalEvidence'
  >;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onBackgroundError?: (error: unknown) => void;
}

function evidenceKey(principalId: string, providerSubjectId: string): string {
  return `${principalId}\u0000${providerSubjectId}`;
}

function boundedMembershipEvidence(
  providerSubjectId: string,
  observation: ProviderMembershipObservation,
): ActiveMembershipEvidence['providerMembershipEvidence'] {
  return {
    status: 'observed',
    providerSubjectId,
    observedAt: observation.observedAt.toISOString(),
    guilds: observation.guilds.map(guild => ({
      guildId: guild.guildId,
      roleIds: [...guild.roleIds],
    })),
  };
}

/** Gateway authority coordinator for bounded Discord evidence lifecycles. */
export class DiscordEvidenceLifecycleCoordinator {
  private readonly config: FleetAuthConfig;
  private readonly runtime: DiscordEvidenceLifecycleOptions['runtime'];
  private readonly store: DiscordEvidenceLifecycleOptions['store'];
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<DiscordEvidenceLifecycleOptions['setTimer']>;
  private readonly clearTimer: NonNullable<DiscordEvidenceLifecycleOptions['clearTimer']>;
  private readonly onBackgroundError: NonNullable<DiscordEvidenceLifecycleOptions['onBackgroundError']>;
  private readonly active = new Map<string, ActiveMembershipEvidence>();
  private readonly reauthentication = new Map<string, DiscordEvidenceReauthenticationReason>();
  private readonly unsubscribers: Array<() => void> = [];
  private pending: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private started = false;
  private closing = false;

  constructor(options: DiscordEvidenceLifecycleOptions) {
    this.config = options.config;
    this.runtime = options.runtime;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
    this.onBackgroundError = options.onBackgroundError ?? ((error) => {
      queueMicrotask(() => { throw error; });
    });
  }

  async start(): Promise<void> {
    await this.enqueue(async () => {
      if (this.started) return;
      await this.store.revokeAllEvidence();
      this.started = true;
    }, true);
  }

  async recordActiveOAuthSession(input: {
    principalId: string;
    providerSubjectId: string;
    providerMembershipEvidence: unknown;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<void> {
    await this.enqueue(() => this.recordActiveOAuthSessionInternal(input));
  }

  async recordSessionRotation(input: {
    principalId: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<void> {
    await this.enqueue(async () => {
      this.assertStarted();
      const matches = [...this.active.values()]
        .filter(entry => entry.principalId === input.principalId);
      for (const entry of matches) {
        entry.sessionExpiresAt = new Date(Math.min(
          input.idleExpiresAt.getTime(),
          input.absoluteExpiresAt.getTime(),
        ));
        await this.refreshOrRequireReauthentication(entry);
      }
    });
  }

  registerCompanionEventSource(
    companionId: string,
    source: DiscordEvidenceLifecycleEventSourcePort,
  ): void {
    this.assertStarted();
    if (this.closing) throw new Error('Discord evidence lifecycle is closing');
    this.unsubscribers.push(source.subscribeDiscordEvidenceLifecycle((event) => {
      void this.handleAuthorityChange(companionId, event).catch(this.onBackgroundError);
    }));
  }

  async handleAuthorityChange(
    companionId: string,
    event: DiscordEvidenceAuthorityChange,
  ): Promise<void> {
    await this.enqueue(() => this.handleAuthorityChangeInternal(companionId, event));
  }

  reauthenticationReason(
    principalId: string,
    providerSubjectId: string,
  ): DiscordEvidenceReauthenticationReason | undefined {
    return this.reauthentication.get(evidenceKey(principalId, providerSubjectId));
  }

  retainedMembershipEvidenceCount(): number {
    return this.active.size;
  }

  async drain(): Promise<void> {
    await this.pending;
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.closePromise = this.enqueue(async () => {
      for (const entry of this.active.values()) {
        if (entry.timer) this.clearTimer(entry.timer);
      }
      await this.store.revokeAllEvidence();
      this.active.clear();
    }, true);
    await this.closePromise;
  }

  private async recordActiveOAuthSessionInternal(input: {
    principalId: string;
    providerSubjectId: string;
    providerMembershipEvidence: unknown;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<void> {
    this.assertStarted();
    const key = evidenceKey(input.principalId, input.providerSubjectId);
    let observation: ReturnType<typeof parseProviderMembershipEvidence>;
    try {
      observation = parseProviderMembershipEvidence(
        input.providerMembershipEvidence,
        input.providerSubjectId,
        new Set(this.config.discordEvidenceMappings.map(mapping => mapping.guildId)).size,
      );
    } catch {
      await this.rejectAdmissionWithoutNewEvidence(input, 'provider_evidence_invalid');
      return;
    }
    if (observation.status !== 'observed') {
      await this.rejectAdmissionWithoutNewEvidence(input, 'provider_evidence_unavailable');
      return;
    }
    const now = this.now();
    const providerExpiresAt = new Date(
      observation.observedAt.getTime() + this.config.ttls.discordEvidenceMs,
    );
    if (observation.observedAt.getTime() > now.getTime()
      || providerExpiresAt.getTime() <= now.getTime()
      || Math.min(input.idleExpiresAt.getTime(), input.absoluteExpiresAt.getTime())
        <= now.getTime()) {
      await this.rejectAdmissionWithoutNewEvidence(input, 'provider_evidence_invalid');
      return;
    }
    const current = this.active.get(key);
    const entry: ActiveMembershipEvidence = {
      principalId: input.principalId,
      providerSubjectId: input.providerSubjectId,
      lifecycleId: randomUUID(),
      generation: 0,
      providerMembershipEvidence: boundedMembershipEvidence(input.providerSubjectId, observation),
      providerExpiresAt,
      sessionExpiresAt: new Date(Math.min(
        input.idleExpiresAt.getTime(),
        input.absoluteExpiresAt.getTime(),
      )),
      renewalAttempted: false,
    };
    await this.store.activatePrincipalEvidenceLifecycle({
      principalId: entry.principalId,
      providerSubjectId: entry.providerSubjectId,
      lifecycleId: entry.lifecycleId,
    });
    if (current?.timer) this.clearTimer(current.timer);
    this.active.set(key, entry);
    this.reauthentication.delete(key);
    try {
      await this.refreshEntry(entry);
      this.schedule(entry);
    } catch (error) {
      await this.failEntry(entry, 'provider_evidence_unavailable', error);
    }
  }

  private async rejectAdmissionWithoutNewEvidence(
    input: { principalId: string; providerSubjectId: string },
    reason: DiscordEvidenceReauthenticationReason,
  ): Promise<void> {
    const key = evidenceKey(input.principalId, input.providerSubjectId);
    const current = this.active.get(key);
    if (current) {
      await this.requireReauthentication(current, reason);
      return;
    }
    this.reauthentication.set(key, reason);
  }

  private async handleAuthorityChangeInternal(
    companionId: string,
    event: DiscordEvidenceAuthorityChange,
  ): Promise<void> {
    this.assertStarted();
    const mappings = this.config.discordEvidenceMappings.filter(mapping => (
      mapping.companionId === companionId
      && (event.kind === 'ready' || mapping.guildId === event.guildId)
    ));
    if (mappings.length === 0) return;
    const guildIds = new Set(mappings.map(mapping => mapping.guildId));
    const matches = [...this.active.values()].filter(entry => (
      (event.kind !== 'member' || entry.providerSubjectId === event.providerSubjectId)
      && entry.providerMembershipEvidence.guilds.some(guild => guildIds.has(guild.guildId))
    ));
    for (const entry of matches) {
      try {
        await this.store.invalidatePrincipalEvidence({
          principalId: entry.principalId,
          providerSubjectId: entry.providerSubjectId,
          companionId,
          mutation: this.nextMutation(entry),
        });
        await this.refreshOrRequireReauthentication(entry, companionId);
      } catch (error) {
        await this.failEntry(entry, 'provider_evidence_unavailable', error);
      }
    }
  }

  private async refreshOrRequireReauthentication(
    entry: ActiveMembershipEvidence,
    companionId?: string,
  ): Promise<void> {
    if (!this.isCurrentEntry(entry)) return;
    const now = this.now();
    if (entry.sessionExpiresAt.getTime() <= now.getTime()) {
      await this.requireReauthentication(entry, 'session_expired');
      return;
    }
    if (entry.providerExpiresAt.getTime() <= now.getTime()) {
      await this.requireReauthentication(entry, 'evidence_expired');
      return;
    }
    await this.refreshEntry(entry, companionId);
    this.schedule(entry);
  }

  private async refreshEntry(
    entry: ActiveMembershipEvidence,
    companionId?: string,
  ): Promise<void> {
    const mutation = this.nextMutation(entry);
    if (companionId) {
      await this.runtime.refreshCompanionEvidence({
        principalId: entry.principalId,
        providerSubjectId: entry.providerSubjectId,
        providerMembershipEvidence: entry.providerMembershipEvidence,
        companionId,
        mutation,
      });
      return;
    }
    await this.runtime.refreshPrincipalEvidence({
      principalId: entry.principalId,
      providerSubjectId: entry.providerSubjectId,
      providerMembershipEvidence: entry.providerMembershipEvidence,
      mutation,
    });
  }

  private schedule(entry: ActiveMembershipEvidence): void {
    if (!this.isCurrentEntry(entry)) return;
    if (entry.timer) this.clearTimer(entry.timer);
    const nowMs = this.now().getTime();
    const expiryMs = Math.min(entry.providerExpiresAt.getTime(), entry.sessionExpiresAt.getTime());
    const renewalLeadMs = Math.max(1, Math.floor(this.config.ttls.discordEvidenceMs / 4));
    const nextAt = entry.renewalAttempted ? expiryMs : Math.max(nowMs, expiryMs - renewalLeadMs);
    const expectedGeneration = entry.generation;
    const expectedLifecycleId = entry.lifecycleId;
    entry.timer = this.setTimer(() => {
      void this.enqueue(() => this.handleTimer(
        entry,
        expectedLifecycleId,
        expectedGeneration,
        expiryMs,
      )).catch(this.onBackgroundError);
    }, Math.max(0, nextAt - nowMs));
  }

  private async handleTimer(
    entry: ActiveMembershipEvidence,
    expectedLifecycleId: string,
    expectedGeneration: number,
    expiryMs: number,
  ): Promise<void> {
    if (!this.isCurrentEntry(entry)
      || entry.lifecycleId !== expectedLifecycleId
      || entry.generation !== expectedGeneration) return;
    try {
      if (!entry.renewalAttempted && this.now().getTime() < expiryMs) {
        entry.renewalAttempted = true;
        await this.refreshOrRequireReauthentication(entry);
        return;
      }
      await this.requireReauthentication(
        entry,
        entry.sessionExpiresAt.getTime() <= this.now().getTime()
          ? 'session_expired'
          : 'evidence_expired',
      );
    } catch (error) {
      await this.failEntry(entry, 'provider_evidence_unavailable', error);
    }
  }

  private async requireReauthentication(
    entry: ActiveMembershipEvidence,
    reason: DiscordEvidenceReauthenticationReason,
  ): Promise<void> {
    if (!this.isCurrentEntry(entry)) return;
    if (entry.timer) this.clearTimer(entry.timer);
    await this.store.revokePrincipalEvidence({
      principalId: entry.principalId,
      providerSubjectId: entry.providerSubjectId,
      mutation: this.nextMutation(entry),
    });
    this.active.delete(evidenceKey(entry.principalId, entry.providerSubjectId));
    this.reauthentication.set(
      evidenceKey(entry.principalId, entry.providerSubjectId),
      reason,
    );
  }

  private async failEntry(
    entry: ActiveMembershipEvidence,
    reason: DiscordEvidenceReauthenticationReason,
    cause: unknown,
  ): Promise<never> {
    try {
      await this.requireReauthentication(entry, reason);
    } catch (revokeError) {
      throw new AggregateError(
        [cause, revokeError],
        'Discord evidence mutation failed and terminal revocation also failed',
      );
    }
    throw cause;
  }

  private nextMutation(entry: ActiveMembershipEvidence): DiscordEvidenceLifecycleMutation {
    entry.generation += 1;
    return { lifecycleId: entry.lifecycleId, generation: entry.generation };
  }

  private isCurrentEntry(entry: ActiveMembershipEvidence): boolean {
    return this.active.get(evidenceKey(entry.principalId, entry.providerSubjectId)) === entry;
  }

  private enqueue<T>(task: () => Promise<T>, allowClosing = false): Promise<T> {
    if (this.closing && !allowClosing) {
      return Promise.reject(new Error('Discord evidence lifecycle is closing'));
    }
    const result = this.pending.then(task);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('Discord evidence lifecycle is not started');
  }
}

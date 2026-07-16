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
} from './discord-evidence-runtime.js';
import {
  boundDiscordMembershipEvidence,
  clearActiveDiscordEvidenceTimers,
  discordEvidenceLifecycleKey,
  retireActiveDiscordEvidence,
  retireAllActiveDiscordEvidence,
  type ActiveDiscordMembershipEvidence,
  type DiscordEvidenceReauthenticationReason,
} from './discord-evidence-lifecycle-state.js';

export type { DiscordEvidenceReauthenticationReason } from './discord-evidence-lifecycle-state.js';

export type DiscordEvidenceLifecycleAdmission =
  | { status: 'admitted' }
  | { status: 'reauthentication_required' };

export interface DiscordEvidenceSessionAuthorityPort {
  fencePrincipalSessionsForDiscordReauthentication(input: {
    principalId: string;
    now: Date;
  }): Promise<void>;
  fenceAllSessionsForDiscordReauthentication(input: { now: Date }): Promise<void>;
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
  sessionAuthority: DiscordEvidenceSessionAuthorityPort;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onBackgroundError?: (error: unknown) => void;
}

/** Gateway authority coordinator for bounded Discord evidence lifecycles. */
export class DiscordEvidenceLifecycleCoordinator {
  private readonly config: FleetAuthConfig;
  private readonly runtime: DiscordEvidenceLifecycleOptions['runtime'];
  private readonly store: DiscordEvidenceLifecycleOptions['store'];
  private readonly sessionAuthority: DiscordEvidenceSessionAuthorityPort;
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<DiscordEvidenceLifecycleOptions['setTimer']>;
  private readonly clearTimer: NonNullable<DiscordEvidenceLifecycleOptions['clearTimer']>;
  private readonly onBackgroundError: NonNullable<DiscordEvidenceLifecycleOptions['onBackgroundError']>;
  private readonly active = new Map<string, ActiveDiscordMembershipEvidence>();
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
    this.sessionAuthority = options.sessionAuthority;
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
      await this.revokeAllAuthority();
      this.started = true;
    }, true);
  }

  async recordActiveOAuthSession(input: {
    principalId: string;
    providerSubjectId: string;
    providerMembershipEvidence: unknown;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<DiscordEvidenceLifecycleAdmission> {
    return await this.enqueue(() => this.recordActiveOAuthSessionInternal(input));
  }

  async recordSessionRotation(input: {
    principalId: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<DiscordEvidenceLifecycleAdmission> {
    return await this.enqueue(async () => {
      this.assertStarted();
      if (this.config.discordEvidenceMappings.length === 0) return { status: 'admitted' };
      const matches = [...this.active.values()]
        .filter(entry => entry.principalId === input.principalId);
      if (matches.length === 0) {
        await this.sessionAuthority.fencePrincipalSessionsForDiscordReauthentication({
          principalId: input.principalId,
          now: this.now(),
        });
        return { status: 'reauthentication_required' };
      }
      for (const entry of matches) {
        entry.sessionExpiresAt = new Date(Math.min(
          input.idleExpiresAt.getTime(),
          input.absoluteExpiresAt.getTime(),
        ));
        await this.refreshOrRequireReauthentication(entry);
      }
      return matches.some(entry => this.isCurrentEntry(entry))
        ? { status: 'admitted' }
        : { status: 'reauthentication_required' };
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
    return this.reauthentication.get(discordEvidenceLifecycleKey(principalId, providerSubjectId));
  }

  retainedMembershipEvidenceCount(): number {
    return this.active.size;
  }

  async drain(): Promise<void> {
    await this.pending;
  }

  async commitGlobalAuthorityReset(reset: () => Promise<void>): Promise<void> {
    await this.enqueue(async () => {
      this.assertStarted();
      await reset();
      retireAllActiveDiscordEvidence(this.active, this.reauthentication, this.clearTimer);
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.closePromise = this.enqueue(async () => {
      clearActiveDiscordEvidenceTimers(this.active, this.clearTimer);
      await this.revokeAllAuthority();
      this.active.clear();
      this.reauthentication.clear();
    }, true);
    await this.closePromise;
  }

  private async recordActiveOAuthSessionInternal(input: {
    principalId: string;
    providerSubjectId: string;
    providerMembershipEvidence: unknown;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<DiscordEvidenceLifecycleAdmission> {
    this.assertStarted();
    if (this.config.discordEvidenceMappings.length === 0) return { status: 'admitted' };
    const key = discordEvidenceLifecycleKey(input.principalId, input.providerSubjectId);
    let observation: ReturnType<typeof parseProviderMembershipEvidence>;
    try {
      observation = parseProviderMembershipEvidence(
        input.providerMembershipEvidence,
        input.providerSubjectId,
        new Set(this.config.discordEvidenceMappings.map(mapping => mapping.guildId)).size,
      );
    } catch {
      return await this.rejectAdmissionWithoutNewEvidence(input, 'provider_evidence_invalid');
    }
    if (observation.status !== 'observed') {
      return await this.rejectAdmissionWithoutNewEvidence(input, 'provider_evidence_unavailable');
    }
    const now = this.now();
    const providerExpiresAt = new Date(
      observation.observedAt.getTime() + this.config.ttls.discordEvidenceMs,
    );
    if (observation.observedAt.getTime() > now.getTime()
      || providerExpiresAt.getTime() <= now.getTime()
      || Math.min(input.idleExpiresAt.getTime(), input.absoluteExpiresAt.getTime())
        <= now.getTime()) {
      return await this.rejectAdmissionWithoutNewEvidence(input, 'provider_evidence_invalid');
    }
    const current = this.active.get(key);
    const entry: ActiveDiscordMembershipEvidence = {
      principalId: input.principalId,
      providerSubjectId: input.providerSubjectId,
      lifecycleId: randomUUID(),
      generation: 0,
      providerMembershipEvidence: boundDiscordMembershipEvidence(input.providerSubjectId, observation),
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
      if (!await this.refreshEntry(entry)) return { status: 'reauthentication_required' };
      this.schedule(entry);
      return { status: 'admitted' };
    } catch (error) {
      await this.failEntry(entry, 'provider_evidence_unavailable', error);
    }
  }

  private async rejectAdmissionWithoutNewEvidence(
    input: { principalId: string; providerSubjectId: string },
    reason: DiscordEvidenceReauthenticationReason,
  ): Promise<DiscordEvidenceLifecycleAdmission> {
    const key = discordEvidenceLifecycleKey(input.principalId, input.providerSubjectId);
    const current = this.active.get(key);
    if (current) {
      await this.requireReauthentication(current, reason);
      return { status: 'reauthentication_required' };
    }
    this.reauthentication.set(key, reason);
    await this.sessionAuthority.fencePrincipalSessionsForDiscordReauthentication({
      principalId: input.principalId,
      now: this.now(),
    });
    return { status: 'reauthentication_required' };
  }

  private async handleAuthorityChangeInternal(
    companionId: string,
    event: DiscordEvidenceAuthorityChange,
  ): Promise<void> {
    this.assertStarted();
    const mappings = this.config.discordEvidenceMappings.filter(mapping => (
      mapping.companionId === companionId
      && (event.kind === 'ready'
        || (event.kind === 'observer' && event.guildId === undefined)
        || mapping.guildId === event.guildId)
    ));
    if (mappings.length === 0) return;
    const guildIds = new Set(mappings.map(mapping => mapping.guildId));
    const matches = [...this.active.values()].filter(entry => (
      (event.kind !== 'member' || entry.providerSubjectId === event.providerSubjectId)
      && entry.providerMembershipEvidence.guilds.some(guild => guildIds.has(guild.guildId))
    ));
    for (const entry of matches) {
      try {
        const mutation = await this.store.invalidatePrincipalEvidence({
          principalId: entry.principalId,
          providerSubjectId: entry.providerSubjectId,
          companionId,
          mutation: this.nextMutation(entry),
        });
        if (mutation.status === 'retired') {
          this.retireEntry(entry);
          continue;
        }
        if (event.kind === 'observer' && event.availability === 'unavailable') {
          entry.renewalAttempted = true;
          this.schedule(entry);
          continue;
        }
        await this.refreshOrRequireReauthentication(entry, companionId);
      } catch (error) {
        await this.failEntry(entry, 'provider_evidence_unavailable', error);
      }
    }
  }

  private async refreshOrRequireReauthentication(
    entry: ActiveDiscordMembershipEvidence,
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
    if (await this.refreshEntry(entry, companionId)) this.schedule(entry);
  }

  private async refreshEntry(
    entry: ActiveDiscordMembershipEvidence,
    companionId?: string,
  ): Promise<boolean> {
    const mutation = this.nextMutation(entry);
    const result = companionId
      ? await this.runtime.refreshCompanionEvidence({
        principalId: entry.principalId,
        providerSubjectId: entry.providerSubjectId,
        providerMembershipEvidence: entry.providerMembershipEvidence,
        companionId,
        mutation,
      })
      : await this.runtime.refreshPrincipalEvidence({
        principalId: entry.principalId,
        providerSubjectId: entry.providerSubjectId,
        providerMembershipEvidence: entry.providerMembershipEvidence,
        mutation,
      });
    if (result.status === 'retired') {
      this.retireEntry(entry);
      return false;
    }
    return true;
  }

  private schedule(entry: ActiveDiscordMembershipEvidence): void {
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
    entry: ActiveDiscordMembershipEvidence,
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
    entry: ActiveDiscordMembershipEvidence,
    reason: DiscordEvidenceReauthenticationReason,
  ): Promise<void> {
    if (!this.isCurrentEntry(entry)) return;
    if (entry.timer) this.clearTimer(entry.timer);
    const errors: unknown[] = [];
    try {
      await this.sessionAuthority.fencePrincipalSessionsForDiscordReauthentication({
        principalId: entry.principalId,
        now: this.now(),
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.store.revokePrincipalEvidence({
        principalId: entry.principalId,
        providerSubjectId: entry.providerSubjectId,
        mutation: this.nextMutation(entry),
      });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Discord evidence terminal authority fencing failed');
    }
    this.retireEntry(entry);
    this.reauthentication.set(
      discordEvidenceLifecycleKey(entry.principalId, entry.providerSubjectId),
      reason,
    );
  }

  private async failEntry(
    entry: ActiveDiscordMembershipEvidence,
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

  private nextMutation(entry: ActiveDiscordMembershipEvidence): DiscordEvidenceLifecycleMutation {
    entry.generation += 1;
    return { lifecycleId: entry.lifecycleId, generation: entry.generation };
  }

  private isCurrentEntry(entry: ActiveDiscordMembershipEvidence): boolean {
    return this.active.get(
      discordEvidenceLifecycleKey(entry.principalId, entry.providerSubjectId),
    ) === entry;
  }

  private retireEntry(entry: ActiveDiscordMembershipEvidence): void {
    retireActiveDiscordEvidence(this.active, this.reauthentication, this.clearTimer, entry);
  }

  private async revokeAllAuthority(): Promise<void> {
    const errors: unknown[] = [];
    if (this.config.discordEvidenceMappings.length > 0) {
      try {
        await this.sessionAuthority.fenceAllSessionsForDiscordReauthentication({ now: this.now() });
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.store.revokeAllEvidence();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Discord evidence global authority fencing failed');
    }
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

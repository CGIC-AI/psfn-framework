import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import type {
  DiscordEvidenceAuthorityChange,
  DiscordEvidenceLifecycleEventSourcePort,
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
  store: Pick<DiscordEvidenceStorePort, 'revokeAllEvidence' | 'revokePrincipalEvidence'>;
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

/**
 * Gateway-owned lifecycle for bounded Discord evidence. The only retained
 * provider material is the normalized guild/member role observation; OAuth
 * access and refresh tokens never enter this coordinator.
 */
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
  private started = false;

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
    if (this.started) return;
    this.started = true;
    // OAuth membership evidence is intentionally memory-only. After a process
    // restart no cached positive can outlive that missing provider input.
    await this.store.revokeAllEvidence();
  }

  async recordActiveOAuthSession(input: {
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
      await this.requireReauthentication(input, 'provider_evidence_invalid');
      return;
    }
    if (observation.status !== 'observed') {
      await this.requireReauthentication(input, 'provider_evidence_unavailable');
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
      await this.requireReauthentication(input, 'provider_evidence_invalid');
      return;
    }
    const current = this.active.get(key);
    if (current?.timer) this.clearTimer(current.timer);
    const entry: ActiveMembershipEvidence = {
      principalId: input.principalId,
      providerSubjectId: input.providerSubjectId,
      providerMembershipEvidence: boundedMembershipEvidence(input.providerSubjectId, observation),
      providerExpiresAt,
      sessionExpiresAt: new Date(Math.min(
        input.idleExpiresAt.getTime(),
        input.absoluteExpiresAt.getTime(),
      )),
      renewalAttempted: false,
    };
    this.active.set(key, entry);
    this.reauthentication.delete(key);
    await this.runtime.refreshPrincipalEvidence({
      principalId: entry.principalId,
      providerSubjectId: entry.providerSubjectId,
      providerMembershipEvidence: entry.providerMembershipEvidence,
    });
    this.schedule(entry);
  }

  async recordSessionRotation(input: {
    principalId: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<void> {
    this.assertStarted();
    const matches = [...this.active.values()].filter(entry => entry.principalId === input.principalId);
    for (const entry of matches) {
      entry.sessionExpiresAt = new Date(Math.min(
        input.idleExpiresAt.getTime(),
        input.absoluteExpiresAt.getTime(),
      ));
      await this.refreshOrRequireReauthentication(entry);
    }
  }

  registerCompanionEventSource(
    companionId: string,
    source: DiscordEvidenceLifecycleEventSourcePort,
  ): void {
    this.assertStarted();
    this.unsubscribers.push(source.subscribeDiscordEvidenceLifecycle((event) => {
      this.pending = this.pending
        .then(() => this.handleAuthorityChange(companionId, event))
        .catch((error) => { this.onBackgroundError(error); });
    }));
  }

  async handleAuthorityChange(
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
      // Revoke first so observation failure cannot leave a stale allow behind.
      await this.store.revokePrincipalEvidence({
        principalId: entry.principalId,
        providerSubjectId: entry.providerSubjectId,
        companionId,
      });
      await this.refreshOrRequireReauthentication(entry, companionId);
    }
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
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const entry of this.active.values()) {
      if (entry.timer) this.clearTimer(entry.timer);
    }
    this.active.clear();
    await this.drain();
  }

  private async refreshOrRequireReauthentication(
    entry: ActiveMembershipEvidence,
    companionId?: string,
  ): Promise<void> {
    const now = this.now();
    if (entry.sessionExpiresAt.getTime() <= now.getTime()) {
      await this.requireReauthentication(entry, 'session_expired');
      return;
    }
    if (entry.providerExpiresAt.getTime() <= now.getTime()) {
      await this.requireReauthentication(entry, 'evidence_expired');
      return;
    }
    if (companionId) {
      await this.runtime.refreshCompanionEvidence({
        principalId: entry.principalId,
        providerSubjectId: entry.providerSubjectId,
        providerMembershipEvidence: entry.providerMembershipEvidence,
        companionId,
      });
    } else {
      await this.runtime.refreshPrincipalEvidence({
        principalId: entry.principalId,
        providerSubjectId: entry.providerSubjectId,
        providerMembershipEvidence: entry.providerMembershipEvidence,
      });
    }
    this.schedule(entry);
  }

  private schedule(entry: ActiveMembershipEvidence): void {
    if (entry.timer) this.clearTimer(entry.timer);
    const nowMs = this.now().getTime();
    const expiryMs = Math.min(entry.providerExpiresAt.getTime(), entry.sessionExpiresAt.getTime());
    const renewalLeadMs = Math.max(1, Math.floor(this.config.ttls.discordEvidenceMs / 4));
    const nextAt = entry.renewalAttempted ? expiryMs : Math.max(nowMs, expiryMs - renewalLeadMs);
    entry.timer = this.setTimer(() => {
      this.pending = this.pending
        .then(async () => {
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
        })
        .catch((error) => { this.onBackgroundError(error); });
    }, Math.max(0, nextAt - nowMs));
  }

  private async requireReauthentication(
    input: { principalId: string; providerSubjectId: string },
    reason: DiscordEvidenceReauthenticationReason,
  ): Promise<void> {
    const key = evidenceKey(input.principalId, input.providerSubjectId);
    const entry = this.active.get(key);
    if (entry?.timer) this.clearTimer(entry.timer);
    this.active.delete(key);
    this.reauthentication.set(key, reason);
    await this.store.revokePrincipalEvidence({
      principalId: input.principalId,
      providerSubjectId: input.providerSubjectId,
    });
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('Discord evidence lifecycle is not started');
  }
}

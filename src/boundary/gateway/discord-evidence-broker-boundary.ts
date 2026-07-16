import type { DiscordEvidenceLifecycleAdmission } from '../fleet-auth/discord-evidence-lifecycle.js';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import {
  DiscordEvidenceAdmissionCoordinator,
  type DiscordEvidenceAdmissionStore,
} from './discord-evidence-admission.js';
import { DiscordOAuthMembershipEvidenceCollector } from './discord-oauth-membership-evidence.js';

export interface DiscordEvidenceLifecyclePort {
  recordActiveOAuthSession(input: {
    principalId: string;
    providerSubjectId: string;
    providerMembershipEvidence: unknown;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<DiscordEvidenceLifecycleAdmission>;
  recordSessionRotation(input: {
    principalId: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<DiscordEvidenceLifecycleAdmission>;
}

interface EvidenceSession {
  recordId: string;
  principalId: string;
  principalStatus: 'pending' | 'active';
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface DiscordEvidenceBrokerOptions<
  TStore extends DiscordEvidenceAdmissionStore = DiscordEvidenceAdmissionStore,
> {
  config: FleetAuthConfig;
  store: TStore;
  discordEvidenceLifecycle?: DiscordEvidenceLifecyclePort;
}

/** Owns Discord evidence collection, lifecycle admission, and compensating revocation. */
export class DiscordEvidenceBrokerBoundary {
  private readonly admission: DiscordEvidenceAdmissionCoordinator;
  private readonly lifecycle?: DiscordEvidenceLifecyclePort;
  private readonly membership: DiscordOAuthMembershipEvidenceCollector;
  private readonly mappingsEnabled: boolean;

  constructor(
    options: DiscordEvidenceBrokerOptions,
    fetchImpl: typeof fetch,
    now: () => Date,
  ) {
    this.lifecycle = options.discordEvidenceLifecycle;
    this.mappingsEnabled = options.config.discordEvidenceMappings.length > 0;
    if (this.mappingsEnabled && !this.lifecycle) {
      throw new Error('Discord evidence mappings require lifecycle admission authority');
    }
    this.admission = new DiscordEvidenceAdmissionCoordinator(options.store, now);
    this.membership = new DiscordOAuthMembershipEvidenceCollector(options.config, fetchImpl, now);
  }

  async collectOAuthMembership(accessToken: string, providerSubjectId: string): Promise<unknown> {
    return await this.membership.collect(accessToken, providerSubjectId);
  }

  async admitActiveOAuthSession(
    session: EvidenceSession,
    providerSubjectId: string,
    providerMembershipEvidence: unknown,
  ): Promise<void> {
    if (session.principalStatus !== 'active' || !this.lifecycle) return;
    await this.admission.require(session, () => this.lifecycle!.recordActiveOAuthSession({
      principalId: session.principalId,
      providerSubjectId,
      providerMembershipEvidence,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    }));
  }

  async admitSessionRotation<T extends EvidenceSession>(session: T): Promise<T> {
    if (!this.lifecycle) return session;
    await this.admission.require(session, () => this.lifecycle!.recordSessionRotation({
      principalId: session.principalId,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    }));
    return session;
  }

  async fenceFirstOwnerActivation<T extends EvidenceSession>(session: T): Promise<T> {
    if (this.mappingsEnabled) await this.admission.deny(session);
    return session;
  }
}

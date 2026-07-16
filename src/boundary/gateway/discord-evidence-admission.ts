import type { DiscordEvidenceLifecycleAdmission } from '../fleet-auth/discord-evidence-lifecycle.js';
import { FleetAuthBrokerError } from './fleet-auth-errors.js';

export interface DiscordEvidenceAdmissionSession {
  recordId: string;
  principalId: string;
}

export interface DiscordEvidenceAdmissionStore {
  revokeIssuedSessionForReauthentication(input: {
    recordId: string;
    principalId: string;
    now: Date;
  }): Promise<void>;
}

/** Enforces lifecycle admission before an issued browser session can escape the broker. */
export class DiscordEvidenceAdmissionCoordinator {
  constructor(
    private readonly store: DiscordEvidenceAdmissionStore,
    private readonly now: () => Date,
  ) {}

  async require(
    session: DiscordEvidenceAdmissionSession,
    admit: () => Promise<DiscordEvidenceLifecycleAdmission>,
  ): Promise<void> {
    let admission: Awaited<ReturnType<typeof admit>>;
    try {
      admission = await admit();
    } catch (error) {
      try {
        await this.store.revokeIssuedSessionForReauthentication({
          recordId: session.recordId,
          principalId: session.principalId,
          now: this.now(),
        });
      } catch (revokeError) {
        throw new AggregateError(
          [error, revokeError],
          'Discord evidence admission failed and issued session revocation also failed',
        );
      }
      throw error;
    }
    if (admission.status === 'reauthentication_required') {
      await this.deny(session);
    }
  }

  async deny(session: DiscordEvidenceAdmissionSession): Promise<never> {
    await this.store.revokeIssuedSessionForReauthentication({
      recordId: session.recordId,
      principalId: session.principalId,
      now: this.now(),
    });
    throw new FleetAuthBrokerError(
      'reauthentication_required',
      401,
      'Reauthentication is required',
    );
  }
}

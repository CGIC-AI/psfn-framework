import { createHash, createHmac, randomUUID } from 'node:crypto';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import {
  compileTrustedHostRecoveryReplayConsumption,
  type TrustedHostRecoveryConsumeResult,
  type TrustedHostRecoveryReplayPort,
} from '../fleet-auth/request-capability-replay.js';
import {
  compileTrustedHostRecoveryTarget,
  type GatewayRequestCapabilitySigner,
  type RequestCapabilityVerifier,
  type TrustedHostRecoveryAuthorityFloor,
  type TrustedHostRecoveryResource,
  type TrustedHostRecoveryTarget,
} from '../fleet-auth/request-capability.js';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export interface TrustedHostRecoveryAuthoritySnapshot
  extends TrustedHostRecoveryAuthorityFloor {
  readonly provisioningSecret: string;
  readonly tombstones: readonly {
    readonly kind: string;
    readonly resourceHash: string;
  }[];
}

export interface TrustedHostRecoveryAuthorityPort {
  readTrustedHost(): TrustedHostRecoveryAuthoritySnapshot;
  revokeRecoveryCredential(input: {
    credentialId: string;
    reason: string;
    at: string;
  }): { readonly trustedHost: TrustedHostRecoveryAuthoritySnapshot };
}

export interface TrustedHostRecoveryExactScope {
  readonly companionId: string;
  readonly action: 'recovery.begin';
  readonly resource: TrustedHostRecoveryResource;
  readonly reason: string;
}

export class TrustedHostGardenRecoveryError extends Error {
  constructor(
    readonly code:
      | 'recovery_request_invalid'
      | 'recovery_credential_rejected'
      | 'recovery_capability_rejected'
      | 'recovery_authority_changed'
      | 'recovery_replay_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'TrustedHostGardenRecoveryError';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function credentialId(provisioningSecret: string, credential: string): string {
  return createHmac('sha256', provisioningSecret)
    .update('fleet-auth-trusted-host-garden-recovery-credential:v1\0', 'utf8')
    .update(credential, 'utf8')
    .digest('hex');
}

function authorityFloor(snapshot: TrustedHostRecoveryAuthoritySnapshot): TrustedHostRecoveryAuthorityFloor {
  return {
    lineageId: snapshot.lineageId,
    authorityGeneration: snapshot.authorityGeneration,
    activationGeneration: snapshot.activationGeneration,
    restoreCheckpoint: snapshot.restoreCheckpoint,
    revocationCheckpoint: snapshot.revocationCheckpoint,
  };
}

function authorityMatches(
  target: TrustedHostRecoveryTarget,
  snapshot: TrustedHostRecoveryAuthoritySnapshot,
): boolean {
  return JSON.stringify(target.authorityFloor) === JSON.stringify(authorityFloor(snapshot));
}

function credentialIsRevoked(
  snapshot: TrustedHostRecoveryAuthoritySnapshot,
  recoveryCredentialId: string,
): boolean {
  const resourceHash = digest(recoveryCredentialId);
  return snapshot.tombstones.some(entry => (
    entry.kind === 'recovery_credential'
      && timingSafeStringEqual(entry.resourceHash, resourceHash)
  ));
}

export class GatewayTrustedHostGardenRecoveryService {
  private serial = Promise.resolve();

  constructor(private readonly options: {
    readonly configuredCredential: string;
    readonly knownCompanionIds: ReadonlySet<string>;
    readonly signer: GatewayRequestCapabilitySigner;
    readonly verifier: RequestCapabilityVerifier;
    readonly replay: TrustedHostRecoveryReplayPort;
    readonly authority: TrustedHostRecoveryAuthorityPort;
  }) {
    if (!options.configuredCredential || options.configuredCredential.length > 8_192) {
      throw new Error('Trusted-host recovery requires a bounded configured credential');
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private compileScope(
    input: TrustedHostRecoveryExactScope,
    presentedCredential: string,
    snapshot: TrustedHostRecoveryAuthoritySnapshot,
  ): TrustedHostRecoveryTarget {
    if (!this.options.knownCompanionIds.has(input.companionId)) {
      throw new TrustedHostGardenRecoveryError(
        'recovery_request_invalid',
        'Recovery scope does not name a known companion',
      );
    }
    return compileTrustedHostRecoveryTarget({
      companionId: input.companionId,
      action: input.action,
      resource: input.resource,
      reason: input.reason,
      credentialId: credentialId(snapshot.provisioningSecret, presentedCredential),
      authorityFloor: authorityFloor(snapshot),
    });
  }

  private async audit(
    outcome: 'issued' | 'revoked' | 'denied',
    target: TrustedHostRecoveryTarget,
    correlationSeed = randomUUID(),
  ): Promise<void> {
    await this.options.replay.auditRecovery({
      outcome,
      companionId: target.companionId,
      targetDigest: target.targetDigest,
      resourceDigest: target.resourceDigest,
      reasonDigest: target.reasonDigest,
      credentialId: target.credentialId,
      authorityFloorDigest: target.authorityFloorDigest,
      correlationId: digest(correlationSeed),
    });
  }

  private async authenticate(
    input: TrustedHostRecoveryExactScope,
    presentedCredential: string,
  ): Promise<{ target: TrustedHostRecoveryTarget; snapshot: TrustedHostRecoveryAuthoritySnapshot }> {
    if (!presentedCredential || presentedCredential.length > 8_192) {
      throw new TrustedHostGardenRecoveryError(
        'recovery_credential_rejected',
        'Trusted-host recovery credential was rejected',
      );
    }
    const snapshot = this.options.authority.readTrustedHost();
    const target = this.compileScope(input, presentedCredential, snapshot);
    const configuredId = credentialId(snapshot.provisioningSecret, this.options.configuredCredential);
    if (!timingSafeStringEqual(presentedCredential, this.options.configuredCredential)
      || !timingSafeStringEqual(target.credentialId, configuredId)
      || credentialIsRevoked(snapshot, configuredId)) {
      await this.audit('denied', target);
      throw new TrustedHostGardenRecoveryError(
        'recovery_credential_rejected',
        'Trusted-host recovery credential was rejected',
      );
    }
    return { target, snapshot };
  }

  async issue(input: TrustedHostRecoveryExactScope & {
    readonly credential: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly kind: 'trusted_host_garden_recovery_capability';
    readonly token: string;
    readonly requestId: string;
    readonly decisionId: string;
    readonly targetDigest: string;
    readonly expiresAt: number;
  }> {
    return await this.exclusive(async () => {
      const { target } = await this.authenticate(input, input.credential);
      const requestId = randomUUID();
      const decisionId = randomUUID();
      const token = this.options.signer.signRecovery({ target, requestId, decisionId });
      const verified = this.options.verifier.verifyRecovery({ token, target });
      await this.audit('issued', target, requestId);
      const current = this.options.authority.readTrustedHost();
      if (!authorityMatches(target, current)
        || credentialIsRevoked(current, target.credentialId)) {
        await this.audit('denied', target);
        throw new TrustedHostGardenRecoveryError(
          'recovery_authority_changed',
          'Trusted-host recovery authority changed before issuance completed',
        );
      }
      if (verified.expiresAt <= Math.floor(Date.now() / 1_000)) {
        await this.audit('denied', target);
        throw new TrustedHostGardenRecoveryError(
          'recovery_capability_rejected',
          'Trusted-host recovery capability expired before issuance completed',
        );
      }
      return Object.freeze({
        schemaVersion: 1,
        kind: 'trusted_host_garden_recovery_capability',
        token,
        requestId,
        decisionId,
        targetDigest: target.targetDigest,
        expiresAt: verified.expiresAt,
      });
    });
  }

  async consume(input: TrustedHostRecoveryExactScope & {
    readonly credential: string;
    readonly token: string;
    readonly transportDigest: string;
  }): Promise<TrustedHostRecoveryConsumeResult> {
    return await this.exclusive(async () => {
      if (!DIGEST_PATTERN.test(input.transportDigest)) {
        throw new TrustedHostGardenRecoveryError(
          'recovery_request_invalid',
          'Recovery request transport digest is invalid',
        );
      }
      const { target } = await this.authenticate(input, input.credential);
      let verified;
      try {
        verified = this.options.verifier.verifyRecovery({ token: input.token, target });
      } catch {
        await this.audit('denied', target);
        throw new TrustedHostGardenRecoveryError(
          'recovery_capability_rejected',
          'Trusted-host recovery capability was rejected',
        );
      }
      const replayInput = compileTrustedHostRecoveryReplayConsumption({
        token: input.token,
        verified,
        target,
        transportDigest: input.transportDigest,
      });
      const replay = await this.options.replay.consumeRecovery(replayInput);
      const current = this.options.authority.readTrustedHost();
      if (!authorityMatches(target, current)
        || credentialIsRevoked(current, target.credentialId)) {
        await this.audit('denied', target);
        throw new TrustedHostGardenRecoveryError(
          'recovery_authority_changed',
          'Trusted-host recovery authority changed before consumption completed',
        );
      }
      if (replay.outcome === 'authority_changed') {
        throw new TrustedHostGardenRecoveryError(
          'recovery_authority_changed',
          'Trusted-host recovery authority changed before consumption completed',
        );
      }
      if (replay.outcome === 'mismatch') {
        throw new TrustedHostGardenRecoveryError(
          'recovery_replay_mismatch',
          'Trusted-host recovery retry did not match the first request bytes',
        );
      }
      if (!('result' in replay)) {
        throw new TrustedHostGardenRecoveryError(
          'recovery_replay_mismatch',
          'Trusted-host recovery replay outcome is missing its result',
        );
      }
      return replay.result;
    });
  }

  async revoke(input: TrustedHostRecoveryExactScope & {
    readonly credential: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly kind: 'trusted_host_recovery_credential_revocation';
    readonly credentialId: string;
    readonly authorityFloorDigest: string;
    readonly revocationCheckpoint: number;
  }> {
    return await this.exclusive(async () => {
      const { target } = await this.authenticate(input, input.credential);
      const next = this.options.authority.revokeRecoveryCredential({
        credentialId: target.credentialId,
        reason: input.reason,
        at: new Date().toISOString(),
      }).trustedHost;
      const revokedTarget = this.compileScope(input, input.credential, next);
      await this.audit('revoked', revokedTarget);
      return Object.freeze({
        schemaVersion: 1,
        kind: 'trusted_host_recovery_credential_revocation',
        credentialId: revokedTarget.credentialId,
        authorityFloorDigest: revokedTarget.authorityFloorDigest,
        revocationCheckpoint: revokedTarget.authorityFloor.revocationCheckpoint,
      });
    });
  }
}

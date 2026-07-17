import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PasskeyAuthorityPort } from './passkey-authority.js';
import type { FleetWebAuthnUvBoundary } from './webauthn-uv.js';
import { digestFleetAuthVerifiedProviderProof } from '../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';

const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export class TrustedHostProviderRecoveryError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'origin_mismatch'
      | 'ceremony_unavailable'
      | 'provider_authority_changed'
      | 'strong_assurance_required',
    message: string,
  ) {
    super(message);
    this.name = 'TrustedHostProviderRecoveryError';
  }
}

export interface ProviderRecoveryOAuthProof {
  provider: 'discord';
  subjectId: string;
  callbackTransactionId: string;
  proofDigest: string;
}

export interface ProviderRecoveryPrincipalClaim {
  principalId: string;
  authnVersion: number;
  authzVersion: number;
  bindingVersion: number;
  grantVersion: number;
  policyVersion: number;
}

export interface ProviderRecoverySessionClaim {
  sessionId: string;
  authnVersion: number;
  authzVersion: number;
  bindingVersion: number;
  grantVersion: number;
  policyVersion: number;
  globalAuthEpoch: number;
  provider: 'discord';
  providerSubjectId: string;
}

export interface PreparedProviderRecovery {
  ceremonyId: string;
  challenge: string;
  companionId: string;
  principal: ProviderRecoveryPrincipalClaim;
  actorSession: ProviderRecoverySessionClaim;
  currentProviderSubjectId: string;
  currentProviderAuthorityGeneration: number;
  expectedNewProviderSubjectId: string;
  authorityGeneration: number;
  globalAuthEpoch: number;
  reasonDigest: string;
  credentialIdHash: string;
  credentialFloorGeneration: number;
}

export interface ProviderRecoveryExecutionInput extends PreparedProviderRecovery {
  decisionId: string;
  oneTimeCredential: string;
  webAuthnReceipt: string;
  credentialGeneration: number;
  completedCredentialFloorGeneration: number;
  newProvider: ProviderRecoveryOAuthProof;
  decidedAt: Date;
}

export interface ProviderRecoveryExecutionResult {
  decisionId: string;
  authorityGeneration: number;
  globalAuthEpoch: number;
}

export interface TrustedHostProviderRecoveryStore {
  auditDenial(input: {
    oneTimeCredential: string;
    reasonCode: 'invalid_request' | 'origin_mismatch' | 'webauthn_denied';
    now: Date;
  }): Promise<void>;
  create(input: {
    ceremonyId: string;
    oneTimeCredential: string;
    companionId: string;
    principalId: string;
    currentProviderSubjectId: string;
    currentProviderAuthorityGeneration: number;
    expectedNewProviderSubjectId: string;
    reasonDigest: string;
    exactOrigin: string;
    rpId: string;
    credentialIdHash: string;
    credentialFloorGeneration: number;
    now: Date;
    expiresAt: Date;
  }): Promise<void>;
  createChallenge(input: {
    oneTimeCredential: string;
    confirmation: 'provider.recover';
    reasonDigest: string;
    newProvider: ProviderRecoveryOAuthProof;
    challenge: string;
    token: string;
    csrfToken: string;
    exactOrigin: string;
    credentialFloorGeneration: number;
    now: Date;
  }): Promise<PreparedProviderRecovery>;
  prepareChallenge(input: {
    oneTimeCredential: string;
    confirmation: 'provider.recover';
    reasonDigest: string;
    newProvider: ProviderRecoveryOAuthProof;
    token: string;
    csrfToken: string;
    exactOrigin: string;
    now: Date;
  }): Promise<PreparedProviderRecovery>;
  recordWebAuthn(input: {
    prepared: PreparedProviderRecovery;
    oneTimeCredential: string;
    webAuthnReceipt: string;
    credentialIdHash: string;
    credentialGeneration: number;
    completedCredentialFloorGeneration: number;
    newProvider: ProviderRecoveryOAuthProof;
    token: string;
    csrfToken: string;
    exactOrigin: string;
    now: Date;
  }): Promise<void>;
}

export interface TrustedHostProviderRecoveryOptions {
  canonicalOrigin: string;
  rpId: string;
  ttlMs: number;
  store: TrustedHostProviderRecoveryStore;
  authority: PasskeyAuthorityPort;
  webAuthn: Pick<FleetWebAuthnUvBoundary, 'startAuthentication' | 'finishAuthentication'>;
  execute(input: ProviderRecoveryExecutionInput): Promise<ProviderRecoveryExecutionResult>;
  now?: () => Date;
  randomBytes?: (length: number) => Buffer;
  randomUuid?: () => string;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function opaque(source: (length: number) => Buffer): string {
  const value = source(32).toString('base64url');
  if (!OPAQUE_PATTERN.test(value)) {
    throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery random source is invalid');
  }
  return value;
}

function reason(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery reason is invalid');
  }
  return normalized;
}

function assertProof(proof: ProviderRecoveryOAuthProof): void {
  const runtimeProvider: unknown = proof.provider;
  if (runtimeProvider !== 'discord' || !SUBJECT_PATTERN.test(proof.subjectId)
    || !isRfc4122Uuid(proof.callbackTransactionId) || !DIGEST_PATTERN.test(proof.proofDigest)) {
    throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery OAuth proof is invalid');
  }
  const expected = digestFleetAuthVerifiedProviderProof({
    provider: proof.provider,
    subjectId: proof.subjectId,
    callbackTransactionId: proof.callbackTransactionId,
  });
  if (!timingSafeEqual(Buffer.from(proof.proofDigest, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery OAuth proof is not exact');
  }
}

/**
 * Trusted-host current-subject-unavailable provider recovery. Host creation is
 * CLI-only; browser completion remains bound to a live old-provider session,
 * exact new-subject OAuth, and a live user-verifying WebAuthn assertion.
 */
export class TrustedHostProviderRecoveryService {
  private readonly origin: string;

  constructor(private readonly options: TrustedHostProviderRecoveryOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.canonicalOrigin);
    } catch {
      throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery origin is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== options.canonicalOrigin
      || parsed.hostname !== options.rpId
      || !Number.isSafeInteger(options.ttlMs) || options.ttlMs < 30_000
      || options.ttlMs > 600_000) {
      throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery RP is invalid');
    }
    this.origin = parsed.origin;
  }

  async create(input: {
    companionId: string;
    principalId: string;
    currentProviderSubjectId: string;
    currentProviderAuthorityGeneration: number;
    expectedNewProviderSubjectId: string;
    reason: string;
    expiresAt: Date;
  }): Promise<{
    ceremonyId: string;
    oneTimeCredential: string;
    expiresAt: Date;
  }> {
    const now = (this.options.now ?? (() => new Date()))();
    if (!isRfc4122Uuid(input.companionId) || !isRfc4122Uuid(input.principalId)
      || !SUBJECT_PATTERN.test(input.currentProviderSubjectId)
      || !SUBJECT_PATTERN.test(input.expectedNewProviderSubjectId)
      || input.currentProviderSubjectId === input.expectedNewProviderSubjectId
      || !Number.isSafeInteger(input.currentProviderAuthorityGeneration)
      || input.currentProviderAuthorityGeneration < 1
      || Number.isNaN(input.expiresAt.getTime())
      || input.expiresAt.getTime() <= now.getTime()
      || input.expiresAt.getTime() > now.getTime() + this.options.ttlMs) {
      throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery binding is invalid');
    }
    const current = this.options.authority.readPasskeys();
    const credential = current.credentials.find(entry => entry.status === 'current'
      && entry.principalId === input.principalId
      && entry.expectedProviderSubjectId === input.currentProviderSubjectId);
    if (!credential) {
      throw new TrustedHostProviderRecoveryError(
        'strong_assurance_required',
        'Recovery requires a current passkey bound to the unavailable provider',
      );
    }
    const source = this.options.randomBytes ?? randomBytes;
    const ceremonyId = (this.options.randomUuid ?? randomUUID)();
    if (!isRfc4122Uuid(ceremonyId)) {
      throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery UUID source is invalid');
    }
    const oneTimeCredential = opaque(source);
    await this.options.store.create({
      ceremonyId,
      oneTimeCredential,
      companionId: input.companionId,
      principalId: input.principalId,
      currentProviderSubjectId: input.currentProviderSubjectId,
      currentProviderAuthorityGeneration: input.currentProviderAuthorityGeneration,
      expectedNewProviderSubjectId: input.expectedNewProviderSubjectId,
      reasonDigest: digest(reason(input.reason)),
      exactOrigin: this.origin,
      rpId: this.options.rpId,
      credentialIdHash: credential.credentialIdHash,
      credentialFloorGeneration: current.generation,
      now,
      expiresAt: input.expiresAt,
    });
    return { ceremonyId, oneTimeCredential, expiresAt: input.expiresAt };
  }

  async start(input: {
    oneTimeCredential: string;
    confirmation: string;
    reason: string;
    newProvider: ProviderRecoveryOAuthProof;
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<{ ceremonyId: string; publicKey: unknown }> {
    let normalizedReason: string;
    try {
      this.assertBrowserInput(input);
      normalizedReason = reason(input.reason);
    } catch (error) {
      await this.auditBrowserDenial(input.oneTimeCredential, error);
      throw error;
    }
    const source = this.options.randomBytes ?? randomBytes;
    const challenge = opaque(source);
    const floor = this.options.authority.readPasskeys();
    const prepared = await this.options.store.createChallenge({
      oneTimeCredential: input.oneTimeCredential,
      confirmation: 'provider.recover',
      reasonDigest: digest(normalizedReason),
      newProvider: input.newProvider,
      challenge,
      token: input.token,
      csrfToken: input.csrfToken,
      exactOrigin: this.origin,
      credentialFloorGeneration: floor.generation,
      now: (this.options.now ?? (() => new Date()))(),
    });
    let publicKey: unknown;
    try {
      publicKey = await this.options.webAuthn.startAuthentication({ challenge });
    } catch (error) {
      await this.options.store.auditDenial({
        oneTimeCredential: input.oneTimeCredential,
        reasonCode: 'webauthn_denied',
        now: (this.options.now ?? (() => new Date()))(),
      });
      throw error;
    }
    return { ceremonyId: prepared.ceremonyId, publicKey };
  }

  async finish(input: {
    oneTimeCredential: string;
    confirmation: string;
    reason: string;
    newProvider: ProviderRecoveryOAuthProof;
    token: string;
    csrfToken: string;
    requestOrigin: string;
    response: unknown;
  }): Promise<ProviderRecoveryExecutionResult> {
    let normalizedReason: string;
    try {
      this.assertBrowserInput(input);
      normalizedReason = reason(input.reason);
    } catch (error) {
      await this.auditBrowserDenial(input.oneTimeCredential, error);
      throw error;
    }
    const now = (this.options.now ?? (() => new Date()))();
    const prepared = await this.options.store.prepareChallenge({
      oneTimeCredential: input.oneTimeCredential,
      confirmation: 'provider.recover',
      reasonDigest: digest(normalizedReason),
      newProvider: input.newProvider,
      token: input.token,
      csrfToken: input.csrfToken,
      exactOrigin: this.origin,
      now,
    });
    let verified: { credentialIdHash: string; generation: number };
    let completedFloor: ReturnType<PasskeyAuthorityPort['readPasskeys']>;
    try {
      verified = await this.options.webAuthn.finishAuthentication({
        response: input.response,
        expectedChallenge: prepared.challenge,
        expectedPrincipalId: prepared.principal.principalId,
        expectedProviderSubjectId: prepared.currentProviderSubjectId,
      });
      if (!timingSafeStringEqual(verified.credentialIdHash, prepared.credentialIdHash)) {
        throw new TrustedHostProviderRecoveryError(
          'provider_authority_changed',
          'Recovery passkey changed during verification',
        );
      }
      completedFloor = this.options.authority.readPasskeys();
      const completedCredential = completedFloor.credentials.find(entry => (
        entry.status === 'current'
          && timingSafeStringEqual(entry.credentialIdHash, verified.credentialIdHash)
          && entry.generation === verified.generation
          && entry.principalId === prepared.principal.principalId
          && entry.expectedProviderSubjectId === prepared.currentProviderSubjectId
      ));
      if (!completedCredential) {
        throw new TrustedHostProviderRecoveryError(
          'provider_authority_changed',
          'Recovery passkey authority changed during verification',
        );
      }
    } catch (error) {
      await this.options.store.auditDenial({
        oneTimeCredential: input.oneTimeCredential,
        reasonCode: 'webauthn_denied',
        now,
      });
      throw error;
    }
    const source = this.options.randomBytes ?? randomBytes;
    const webAuthnReceipt = opaque(source);
    await this.options.store.recordWebAuthn({
      prepared,
      oneTimeCredential: input.oneTimeCredential,
      webAuthnReceipt,
      credentialIdHash: verified.credentialIdHash,
      credentialGeneration: verified.generation,
      completedCredentialFloorGeneration: completedFloor.generation,
      newProvider: input.newProvider,
      token: input.token,
      csrfToken: input.csrfToken,
      exactOrigin: this.origin,
      now,
    });
    const decisionId = (this.options.randomUuid ?? randomUUID)();
    if (!isRfc4122Uuid(decisionId)) {
      throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery UUID source is invalid');
    }
    return await this.options.execute({
      ...prepared,
      decisionId,
      oneTimeCredential: input.oneTimeCredential,
      webAuthnReceipt,
      credentialGeneration: verified.generation,
      completedCredentialFloorGeneration: completedFloor.generation,
      newProvider: input.newProvider,
      decidedAt: now,
    });
  }

  private assertBrowserInput(input: {
    oneTimeCredential: string;
    confirmation: string;
    newProvider: ProviderRecoveryOAuthProof;
    requestOrigin: string;
  }): void {
    if (input.requestOrigin !== this.origin) {
      throw new TrustedHostProviderRecoveryError('origin_mismatch', 'Recovery origin is invalid');
    }
    if (!OPAQUE_PATTERN.test(input.oneTimeCredential)
      || input.confirmation !== 'provider.recover') {
      throw new TrustedHostProviderRecoveryError('invalid_request', 'Recovery confirmation is invalid');
    }
    assertProof(input.newProvider);
  }

  private async auditBrowserDenial(oneTimeCredential: string, error: unknown): Promise<void> {
    await this.options.store.auditDenial({
      oneTimeCredential,
      reasonCode: error instanceof TrustedHostProviderRecoveryError
        && error.code === 'origin_mismatch'
        ? 'origin_mismatch'
        : 'invalid_request',
      now: (this.options.now ?? (() => new Date()))(),
    });
  }
}

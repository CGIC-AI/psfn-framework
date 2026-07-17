import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PasskeyAuthorityPort } from './passkey-authority.js';
import type { FleetWebAuthnUvBoundary } from './webauthn-uv.js';
import { digestFleetAuthVerifiedProviderProof } from '../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import {
  assertNoUnknownKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export interface TrustedHostAccountReapprovalProviderProof {
  provider: 'discord';
  subjectId: string;
  callbackTransactionId: string;
  proofDigest: string;
}

export interface PreparedAccountReapprovalCeremony {
  ceremonyId: string;
  challenge: string;
  principalId: string;
  providerSubjectId: string;
  companionId: string;
  contactId: string;
  bindingId: string;
  roleGrantId: string;
  credentialFloorGeneration: number;
  actorPrincipalId: string;
  actorSessionId: string;
  oauthTransactionId: string;
  oauthProofDigest: string;
}

export interface AccountReapprovalAuthorityResult {
  principalId: string;
  authorityGeneration: number;
  globalAuthEpoch: number;
  authnVersion: number;
  authzVersion: number;
  bindingVersion: number;
  roleVersion: number;
  auditEventId: string;
}

export interface TrustedHostAccountReapprovalStore {
  create(input: {
    ceremonyId: string;
    nonce: string;
    challenge: string;
    expectedProviderSubjectId: string;
    expectedPrincipalId: string;
    expectedCompanionId: string;
    expectedContactId: string;
    expectedBindingId: string;
    expectedRoleGrantId: string;
    reasonDigest: string;
    exactOrigin: string;
    rpId: string;
    credentialFloorGeneration: number;
    now: Date;
    expiresAt: Date;
  }): Promise<void>;
  prepare(input: {
    nonce: string;
    token: string;
    csrfToken: string;
    providerProof: TrustedHostAccountReapprovalProviderProof;
    exactOrigin: string;
    now: Date;
  }): Promise<PreparedAccountReapprovalCeremony>;
  confirm(input: {
    ceremony: PreparedAccountReapprovalCeremony;
    token: string;
    csrfToken: string;
    providerProof: TrustedHostAccountReapprovalProviderProof;
    credentialIdHash: string;
    credentialGeneration: number;
    credentialFloorGeneration: number;
    now: Date;
  }): Promise<void>;
  recordDenial(input: {
    nonce: string;
    stage: 'start' | 'finish';
    reasonCode: string;
    now: Date;
  }): Promise<void>;
}

export class TrustedHostAccountReapprovalError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'origin_mismatch'
      | 'ceremony_unavailable'
      | 'passkey_authority_changed'
      | 'reapproval_denied',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TrustedHostAccountReapprovalError';
  }
}

export interface TrustedHostAccountReapprovalOptions {
  canonicalOrigin: string;
  rpId: string;
  ttlMs: number;
  store: TrustedHostAccountReapprovalStore;
  authority: Pick<PasskeyAuthorityPort, 'readPasskeys'>;
  webAuthn: Pick<FleetWebAuthnUvBoundary, 'startAuthentication' | 'finishAuthentication'>;
  reapprove(input: {
    ceremonyId: string;
    principalId: string;
    provider: 'discord';
    providerSubjectId: string;
    companionId: string;
    contactId: string;
    bindingId: string;
    roleGrantId: string;
    auditEventId: string;
    at: string;
  }): Promise<AccountReapprovalAuthorityResult>;
  now?: () => Date;
  randomBytes?: (length: number) => Buffer;
  randomUuid?: () => string;
}

export interface TrustedHostAccountReapprovalCreated {
  ceremonyId: string;
  nonce: string;
  expiresAt: Date;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function opaqueNonce(source: (length: number) => Buffer): string {
  const value = source(32).toString('base64url');
  if (!NONCE_PATTERN.test(value)) {
    throw new TrustedHostAccountReapprovalError(
      'invalid_request',
      'Trusted-host random source returned invalid output',
    );
  }
  return value;
}

function checkedReason(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TrustedHostAccountReapprovalError(
      'invalid_request',
      'Account reapproval reason is invalid',
    );
  }
  return normalized;
}

export function parseAccountReapprovalProviderProof(
  value: unknown,
): TrustedHostAccountReapprovalProviderProof {
  if (!isRecord(value)) {
    throw new TrustedHostAccountReapprovalError('invalid_request', 'Provider proof is invalid');
  }
  assertNoUnknownKeys(
    value,
    ['provider', 'subjectId', 'callbackTransactionId', 'proofDigest'],
    'accountReapprovalProviderProof',
  );
  if (value.provider !== 'discord'
    || typeof value.subjectId !== 'string'
    || !SUBJECT_PATTERN.test(value.subjectId)
    || typeof value.callbackTransactionId !== 'string'
    || !isRfc4122Uuid(value.callbackTransactionId)
    || typeof value.proofDigest !== 'string'
    || !DIGEST_PATTERN.test(value.proofDigest)) {
    throw new TrustedHostAccountReapprovalError('invalid_request', 'Provider proof is invalid');
  }
  const expectedDigest = digestFleetAuthVerifiedProviderProof({
    provider: 'discord',
    subjectId: value.subjectId,
    callbackTransactionId: value.callbackTransactionId,
  });
  if (value.proofDigest !== expectedDigest) {
    throw new TrustedHostAccountReapprovalError('invalid_request', 'Provider proof is invalid');
  }
  return {
    provider: 'discord',
    subjectId: value.subjectId,
    callbackTransactionId: value.callbackTransactionId,
    proofDigest: value.proofDigest,
  };
}

/**
 * Trusted-host orchestration for restored account authority. Creation is an
 * explicit repo CLI decision; browser completion adds an active session,
 * current Discord OAuth evidence, and UV authentication with an existing
 * non-restored passkey. This service never enrolls or recovers credentials.
 */
export class TrustedHostAccountReapprovalService {
  private readonly origin: string;

  constructor(private readonly options: TrustedHostAccountReapprovalOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.canonicalOrigin);
    } catch {
      throw new TrustedHostAccountReapprovalError('invalid_request', 'Reapproval origin is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== options.canonicalOrigin
      || parsed.hostname !== options.rpId
      || !Number.isSafeInteger(options.ttlMs) || options.ttlMs < 30_000
      || options.ttlMs > 600_000) {
      throw new TrustedHostAccountReapprovalError(
        'invalid_request',
        'Account reapproval configuration is invalid',
      );
    }
    this.origin = parsed.origin;
  }

  async create(input: {
    expectedProviderSubjectId: string;
    expectedPrincipalId: string;
    expectedCompanionId: string;
    expectedContactId: string;
    expectedBindingId: string;
    expectedRoleGrantId: string;
    reason: string;
  }): Promise<TrustedHostAccountReapprovalCreated> {
    if (!SUBJECT_PATTERN.test(input.expectedProviderSubjectId)
      || !isRfc4122Uuid(input.expectedPrincipalId)
      || !isRfc4122Uuid(input.expectedCompanionId)
      || !input.expectedContactId.trim()
      || input.expectedContactId.length > 256
      || !isRfc4122Uuid(input.expectedBindingId)
      || !isRfc4122Uuid(input.expectedRoleGrantId)) {
      throw new TrustedHostAccountReapprovalError(
        'invalid_request',
        'Account reapproval binding is invalid',
      );
    }
    const floor = this.options.authority.readPasskeys();
    if (!floor.credentials.some(entry => entry.status === 'current'
      && entry.principalId === input.expectedPrincipalId
      && entry.expectedProviderSubjectId === input.expectedProviderSubjectId)) {
      throw new TrustedHostAccountReapprovalError(
        'passkey_authority_changed',
        'Account reapproval requires an existing current passkey',
      );
    }
    const source = this.options.randomBytes ?? randomBytes;
    const nonce = opaqueNonce(source);
    const challenge = opaqueNonce(source);
    const ceremonyId = (this.options.randomUuid ?? randomUUID)();
    if (!isRfc4122Uuid(ceremonyId)) {
      throw new TrustedHostAccountReapprovalError('invalid_request', 'Ceremony UUID is invalid');
    }
    const now = (this.options.now ?? (() => new Date()))();
    const expiresAt = new Date(now.getTime() + this.options.ttlMs);
    await this.options.store.create({
      ceremonyId,
      nonce,
      challenge,
      expectedProviderSubjectId: input.expectedProviderSubjectId,
      expectedPrincipalId: input.expectedPrincipalId,
      expectedCompanionId: input.expectedCompanionId,
      expectedContactId: input.expectedContactId.trim(),
      expectedBindingId: input.expectedBindingId,
      expectedRoleGrantId: input.expectedRoleGrantId,
      reasonDigest: digest(checkedReason(input.reason)),
      exactOrigin: this.origin,
      rpId: this.options.rpId,
      credentialFloorGeneration: floor.generation,
      now,
      expiresAt,
    });
    return { ceremonyId, nonce, expiresAt };
  }

  async startAuthentication(input: {
    nonce: string;
    token: string;
    csrfToken: string;
    requestOrigin: string;
    providerProof: TrustedHostAccountReapprovalProviderProof;
  }): Promise<{ ceremonyId: string; publicKey: unknown }> {
    return await this.withDenialAudit('start', input.nonce, async () => {
      this.assertOrigin(input.requestOrigin);
      this.assertNonce(input.nonce);
      const providerProof = parseAccountReapprovalProviderProof(input.providerProof);
      const ceremony = await this.options.store.prepare({
        nonce: input.nonce,
        token: input.token,
        csrfToken: input.csrfToken,
        providerProof,
        exactOrigin: this.origin,
        now: (this.options.now ?? (() => new Date()))(),
      });
      const publicKey = await this.options.webAuthn.startAuthentication({
        challenge: ceremony.challenge,
      });
      return { ceremonyId: ceremony.ceremonyId, publicKey };
    });
  }

  async finishAuthentication(input: {
    nonce: string;
    token: string;
    csrfToken: string;
    requestOrigin: string;
    providerProof: TrustedHostAccountReapprovalProviderProof;
    response: unknown;
  }): Promise<AccountReapprovalAuthorityResult & { reauthenticationRequired: true }> {
    return await this.withDenialAudit('finish', input.nonce, async () => {
      this.assertOrigin(input.requestOrigin);
      this.assertNonce(input.nonce);
      const providerProof = parseAccountReapprovalProviderProof(input.providerProof);
      const now = (this.options.now ?? (() => new Date()))();
      const ceremony = await this.options.store.prepare({
        nonce: input.nonce,
        token: input.token,
        csrfToken: input.csrfToken,
        providerProof,
        exactOrigin: this.origin,
        now,
      });
      const verified = await this.options.webAuthn.finishAuthentication({
        response: input.response,
        expectedChallenge: ceremony.challenge,
        expectedPrincipalId: ceremony.principalId,
        expectedProviderSubjectId: ceremony.providerSubjectId,
      });
      const floor = this.options.authority.readPasskeys();
      const credential = floor.credentials.find(entry => entry.status === 'current'
        && entry.credentialIdHash === verified.credentialIdHash
        && entry.principalId === ceremony.principalId
        && entry.expectedProviderSubjectId === ceremony.providerSubjectId);
      if (!credential || credential.generation !== verified.generation) {
        throw new TrustedHostAccountReapprovalError(
          'passkey_authority_changed',
          'Passkey authority changed during account reapproval',
        );
      }
      await this.options.store.confirm({
        ceremony,
        token: input.token,
        csrfToken: input.csrfToken,
        providerProof,
        credentialIdHash: credential.credentialIdHash,
        credentialGeneration: credential.generation,
        credentialFloorGeneration: floor.generation,
        now,
      });
      const activationFloor = this.options.authority.readPasskeys();
      const activationCredential = activationFloor.credentials.find(entry => entry.status === 'current'
        && entry.credentialIdHash === credential.credentialIdHash
        && entry.principalId === ceremony.principalId
        && entry.expectedProviderSubjectId === ceremony.providerSubjectId);
      if (activationFloor.generation !== floor.generation
        || activationCredential?.generation !== credential.generation) {
        throw new TrustedHostAccountReapprovalError(
          'passkey_authority_changed',
          'Passkey authority changed before account activation',
        );
      }
      const result = await this.options.reapprove({
        ceremonyId: ceremony.ceremonyId,
        principalId: ceremony.principalId,
        provider: 'discord',
        providerSubjectId: ceremony.providerSubjectId,
        companionId: ceremony.companionId,
        contactId: ceremony.contactId,
        bindingId: ceremony.bindingId,
        roleGrantId: ceremony.roleGrantId,
        auditEventId: (this.options.randomUuid ?? randomUUID)(),
        at: now.toISOString(),
      });
      return { ...result, reauthenticationRequired: true as const };
    });
  }

  private assertNonce(value: string): void {
    if (!NONCE_PATTERN.test(value)) {
      throw new TrustedHostAccountReapprovalError('invalid_request', 'Reapproval nonce is invalid');
    }
  }

  private assertOrigin(value: string): void {
    if (value !== this.origin) {
      throw new TrustedHostAccountReapprovalError(
        'origin_mismatch',
        'Account reapproval origin is invalid',
      );
    }
  }

  private async withDenialAudit<T>(
    stage: 'start' | 'finish',
    nonce: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const reasonCode = error instanceof TrustedHostAccountReapprovalError
        ? error.code
        : 'reapproval_denied';
      try {
        await this.options.store.recordDenial({
          nonce,
          stage,
          reasonCode,
          now: (this.options.now ?? (() => new Date()))(),
        });
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          'Account reapproval denial audit failed',
        );
      }
      if (error instanceof TrustedHostAccountReapprovalError) throw error;
      throw new TrustedHostAccountReapprovalError(
        'reapproval_denied',
        'Account reapproval was denied',
        { cause: error },
      );
    }
  }
}

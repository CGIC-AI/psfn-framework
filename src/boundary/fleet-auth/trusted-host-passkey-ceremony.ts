import { randomBytes, randomUUID } from 'node:crypto';
import type {
  PasskeyAuthorityCandidate,
  PasskeyAuthorityFloor,
  PasskeyAuthorityPort,
} from './passkey-authority.js';
import type { FleetWebAuthnUvBoundary } from './webauthn-uv.js';
import { assertNoUnknownKeys, isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type TrustedHostPasskeyCeremonyKind =
  | 'first_owner'
  | 'passkey_enrollment'
  | 'passkey_recovery';

export class TrustedHostPasskeyCeremonyError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'origin_mismatch'
      | 'ceremony_unavailable'
      | 'passkey_authority_changed',
    message: string,
  ) {
    super(message);
    this.name = 'TrustedHostPasskeyCeremonyError';
  }
}

export interface PreparedPasskeyCeremony {
  ceremonyId: string;
  kind: TrustedHostPasskeyCeremonyKind;
  challenge: string;
  principalId: string;
  providerSubjectId: string;
  companionId?: string;
  contactId?: string;
  priorCredentialIdHash?: string;
  credentialFloorGeneration: number;
}

export interface TrustedHostPasskeyCeremonyStore {
  create(input: {
    ceremonyId: string;
    nonce: string;
    challenge: string;
    kind: TrustedHostPasskeyCeremonyKind;
    expectedProviderSubjectId: string;
    expectedCompanionId?: string;
    expectedContactId?: string;
    priorCredentialIdHash?: string;
    exactOrigin: string;
    rpId: string;
    credentialFloorGeneration: number;
    now: Date;
    expiresAt: Date;
  }): Promise<void>;
  prepare(input: {
    nonce: string;
    kind: TrustedHostPasskeyCeremonyKind;
    exactOrigin: string;
    now: Date;
    token?: string;
    csrfToken?: string;
  }): Promise<PreparedPasskeyCeremony>;
  finalizeCredential(input: {
    ceremony: PreparedPasskeyCeremony;
    candidate: PasskeyAuthorityCandidate;
    completedCredentialFloorGeneration: number;
    now: Date;
  }): Promise<void>;
  bindFirstOwnerCredential(input: {
    ceremony: PreparedPasskeyCeremony;
    candidate: PasskeyAuthorityCandidate;
    completedCredentialFloorGeneration: number;
    now: Date;
  }): Promise<void>;
}

export interface MutablePasskeyAuthorityPort extends PasskeyAuthorityPort {
  enrollPasskey(candidate: PasskeyAuthorityCandidate, at: string): { passkeys: PasskeyAuthorityFloor };
  replacePasskey(input: {
    priorCredentialIdHash: string;
    replacement: PasskeyAuthorityCandidate;
    at: string;
  }): { passkeys: PasskeyAuthorityFloor };
}

export interface TrustedHostPasskeyCeremonyOptions {
  canonicalOrigin: string;
  rpId: string;
  ttlMs: number;
  store: TrustedHostPasskeyCeremonyStore;
  authority: MutablePasskeyAuthorityPort;
  webAuthn: Pick<FleetWebAuthnUvBoundary, 'startRegistration' | 'finishRegistration'>;
  now?: () => Date;
  randomBytes?: (length: number) => Buffer;
  randomUuid?: () => string;
}

export interface TrustedHostCeremonyCreated {
  ceremonyId: string;
  nonce: string;
  kind: TrustedHostPasskeyCeremonyKind;
  expiresAt: Date;
}

function opaqueNonce(source: (length: number) => Buffer): string {
  const value = source(32).toString('base64url');
  if (!NONCE_PATTERN.test(value)) {
    throw new TrustedHostPasskeyCeremonyError(
      'invalid_request',
      'Trusted-host random source returned invalid output',
    );
  }
  return value;
}

function candidateMatches(left: PasskeyAuthorityCandidate, right: PasskeyAuthorityCandidate): boolean {
  return left.credentialIdHash === right.credentialIdHash
    && left.publicKeyVerifier === right.publicKeyVerifier
    && left.rpId === right.rpId
    && left.principalId === right.principalId
    && left.expectedProviderSubjectId === right.expectedProviderSubjectId
    && left.signCount === right.signCount
    && left.backupEligible === right.backupEligible
    && left.backupState === right.backupState;
}

/**
 * Repo-owned trusted-host passkey lane. Ceremony creation is the explicit host
 * confirmation. Browser completion still requires matching OAuth session
 * authority plus a live exact-origin/RP user-verifying registration.
 */
export class TrustedHostPasskeyCeremonyService {
  private readonly origin: string;

  constructor(private readonly options: TrustedHostPasskeyCeremonyOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.canonicalOrigin);
    } catch {
      throw new TrustedHostPasskeyCeremonyError('invalid_request', 'Passkey origin is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== options.canonicalOrigin
      || parsed.hostname !== options.rpId
      || !Number.isSafeInteger(options.ttlMs) || options.ttlMs < 30_000
      || options.ttlMs > 600_000) {
      throw new TrustedHostPasskeyCeremonyError('invalid_request', 'Passkey ceremony configuration is invalid');
    }
    this.origin = parsed.origin;
  }

  async create(input: {
    kind: TrustedHostPasskeyCeremonyKind;
    expectedProviderSubjectId: string;
    expectedCompanionId?: string;
    expectedContactId?: string;
    priorCredentialIdHash?: string;
  }): Promise<TrustedHostCeremonyCreated> {
    if (!SUBJECT_PATTERN.test(input.expectedProviderSubjectId)
      || (input.kind === 'first_owner'
        && (!input.expectedCompanionId || !isRfc4122Uuid(input.expectedCompanionId)
          || !input.expectedContactId?.trim() || input.expectedContactId.length > 256))
      || (input.kind !== 'first_owner'
        && (input.expectedCompanionId !== undefined || input.expectedContactId !== undefined))
      || (input.kind === 'passkey_recovery') !== Boolean(
        input.priorCredentialIdHash && DIGEST_PATTERN.test(input.priorCredentialIdHash),
      )) {
      throw new TrustedHostPasskeyCeremonyError('invalid_request', 'Trusted-host ceremony binding is invalid');
    }
    const source = this.options.randomBytes ?? randomBytes;
    const nonce = opaqueNonce(source);
    const challenge = opaqueNonce(source);
    const ceremonyId = (this.options.randomUuid ?? randomUUID)();
    if (!isRfc4122Uuid(ceremonyId)) {
      throw new TrustedHostPasskeyCeremonyError('invalid_request', 'Ceremony UUID is invalid');
    }
    const floor = this.options.authority.readPasskeys();
    if (input.kind === 'passkey_recovery') {
      const prior = floor.credentials.find(entry => entry.status === 'current'
        && entry.credentialIdHash === input.priorCredentialIdHash
        && entry.expectedProviderSubjectId === input.expectedProviderSubjectId);
      if (!prior) {
        throw new TrustedHostPasskeyCeremonyError(
          'passkey_authority_changed',
          'Recovery prior credential is not current',
        );
      }
    }
    const now = (this.options.now ?? (() => new Date()))();
    const expiresAt = new Date(now.getTime() + this.options.ttlMs);
    await this.options.store.create({
      ceremonyId,
      nonce,
      challenge,
      kind: input.kind,
      expectedProviderSubjectId: input.expectedProviderSubjectId,
      ...(input.expectedCompanionId ? { expectedCompanionId: input.expectedCompanionId } : {}),
      ...(input.expectedContactId ? { expectedContactId: input.expectedContactId.trim() } : {}),
      ...(input.priorCredentialIdHash
        ? { priorCredentialIdHash: input.priorCredentialIdHash }
        : {}),
      exactOrigin: this.origin,
      rpId: this.options.rpId,
      credentialFloorGeneration: floor.generation,
      now,
      expiresAt,
    });
    return { ceremonyId, nonce, kind: input.kind, expiresAt };
  }

  async startRegistration(input: {
    nonce: string;
    kind: TrustedHostPasskeyCeremonyKind;
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<{ ceremonyId: string; kind: TrustedHostPasskeyCeremonyKind; publicKey: unknown }> {
    this.assertOrigin(input.requestOrigin);
    const ceremony = await this.options.store.prepare({
      nonce: input.nonce,
      kind: input.kind,
      exactOrigin: this.origin,
      now: (this.options.now ?? (() => new Date()))(),
      token: input.token,
      csrfToken: input.csrfToken,
    });
    const publicKey = await this.options.webAuthn.startRegistration({
      challenge: ceremony.challenge,
      principalId: ceremony.principalId,
    });
    return { ceremonyId: ceremony.ceremonyId, kind: ceremony.kind, publicKey };
  }

  async finishRegistration(input: {
    nonce: string;
    kind: 'passkey_enrollment' | 'passkey_recovery';
    token: string;
    csrfToken: string;
    requestOrigin: string;
    response: unknown;
  }): Promise<{ credentialIdHash: string; credentialFloorGeneration: number }> {
    this.assertOrigin(input.requestOrigin);
    const now = (this.options.now ?? (() => new Date()))();
    const ceremony = await this.options.store.prepare({
      nonce: input.nonce,
      kind: input.kind,
      exactOrigin: this.origin,
      now,
      token: input.token,
      csrfToken: input.csrfToken,
    });
    const candidate = await this.options.webAuthn.finishRegistration({
      response: input.response,
      expectedChallenge: ceremony.challenge,
      principalId: ceremony.principalId,
      expectedProviderSubjectId: ceremony.providerSubjectId,
    });
    const floor = this.publishCredential(ceremony, candidate, now);
    await this.options.store.finalizeCredential({
      ceremony,
      candidate,
      completedCredentialFloorGeneration: floor.generation,
      now,
    });
    return {
      credentialIdHash: candidate.credentialIdHash,
      credentialFloorGeneration: floor.generation,
    };
  }

  async verifyFirstOwner(input: {
    evidence: unknown;
    expectedOrigin: string;
  }): Promise<{
    ceremonyId: string;
    principalId: string;
    providerSubjectId: string;
    companionId: string;
    contactId: string;
  }> {
    this.assertOrigin(input.expectedOrigin);
    if (!isRecord(input.evidence)) {
      throw new TrustedHostPasskeyCeremonyError('invalid_request', 'First-owner evidence is invalid');
    }
    assertNoUnknownKeys(input.evidence, ['nonce', 'response'], 'firstOwnerEvidence');
    if (typeof input.evidence.nonce !== 'string' || !NONCE_PATTERN.test(input.evidence.nonce)) {
      throw new TrustedHostPasskeyCeremonyError('invalid_request', 'First-owner nonce is invalid');
    }
    const now = (this.options.now ?? (() => new Date()))();
    const ceremony = await this.options.store.prepare({
      nonce: input.evidence.nonce,
      kind: 'first_owner',
      exactOrigin: this.origin,
      now,
    });
    if (!ceremony.companionId || !ceremony.contactId) {
      throw new TrustedHostPasskeyCeremonyError(
        'ceremony_unavailable',
        'First-owner ceremony scope is incomplete',
      );
    }
    const candidate = await this.options.webAuthn.finishRegistration({
      response: input.evidence.response,
      expectedChallenge: ceremony.challenge,
      principalId: ceremony.principalId,
      expectedProviderSubjectId: ceremony.providerSubjectId,
    });
    const floor = this.publishCredential(ceremony, candidate, now);
    await this.options.store.bindFirstOwnerCredential({
      ceremony,
      candidate,
      completedCredentialFloorGeneration: floor.generation,
      now,
    });
    return {
      ceremonyId: ceremony.ceremonyId,
      principalId: ceremony.principalId,
      providerSubjectId: ceremony.providerSubjectId,
      companionId: ceremony.companionId,
      contactId: ceremony.contactId,
    };
  }

  private publishCredential(
    ceremony: PreparedPasskeyCeremony,
    candidate: PasskeyAuthorityCandidate,
    now: Date,
  ): PasskeyAuthorityFloor {
    const current = this.options.authority.readPasskeys();
    const alreadyCurrent = current.credentials.find(entry => entry.status === 'current'
      && candidateMatches(entry, candidate));
    if (alreadyCurrent) return current;
    if (current.generation !== ceremony.credentialFloorGeneration) {
      throw new TrustedHostPasskeyCeremonyError(
        'passkey_authority_changed',
        'Passkey authority changed during registration',
      );
    }
    if (ceremony.kind === 'passkey_recovery') {
      if (!ceremony.priorCredentialIdHash) {
        throw new TrustedHostPasskeyCeremonyError('ceremony_unavailable', 'Recovery scope is incomplete');
      }
      return this.options.authority.replacePasskey({
        priorCredentialIdHash: ceremony.priorCredentialIdHash,
        replacement: candidate,
        at: now.toISOString(),
      }).passkeys;
    }
    return this.options.authority.enrollPasskey(candidate, now.toISOString()).passkeys;
  }

  private assertOrigin(value: string): void {
    if (value !== this.origin) {
      throw new TrustedHostPasskeyCeremonyError('origin_mismatch', 'Passkey ceremony origin is invalid');
    }
  }
}

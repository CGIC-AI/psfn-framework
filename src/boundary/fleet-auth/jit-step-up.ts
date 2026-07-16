import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FleetAuthAction } from '../../system/config/fleet-auth-config.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import type { CompiledGardenRequestTarget } from './request-capability-target.js';
import type { FleetWebAuthnUvBoundary } from './webauthn-uv.js';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type FleetJitAssurance = 'webauthn_uv' | 'discord_possession';

export class FleetJitStepUpError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'origin_mismatch'
      | 'strong_assurance_required'
      | 'lower_assurance_unavailable'
      | 'challenge_unavailable'
      | 'grant_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FleetJitStepUpError';
  }
}

export interface FleetJitRequestBinding {
  /** Compiled from the declared Garden route, never from browser authority fields. */
  target: Pick<CompiledGardenRequestTarget,
    | 'companionId'
    | 'action'
    | 'resourceDigest'
    | 'authorizationDigest'
    | 'targetDigest'
    | 'authorization'>;
  /** Digest of the authorization layer's canonical self/co-subject projection. */
  subjectScopeDigest: string;
  /** Human-readable intent is hashed before durable storage and audit. */
  purpose: string;
  memoryRevision: number;
  classifierEvidenceDigest: string;
}

export interface FleetJitChallengeIdentity {
  principalId: string;
  providerSubjectId: string;
  browserSessionId: string;
  globalAuthEpoch: number;
}

export interface FleetJitDurableRequestBinding {
  companionId: string;
  action: FleetAuthAction;
  resourceDigest: string;
  authorizationDigest: string;
  targetDigest: string;
  subjectScopeDigest: string;
  purposeDigest: string;
  memoryRevision: number;
  classifierEvidenceDigest: string;
  assuranceRequirement: 'none' | 'oauth' | 'webauthn_uv' | 'privacy_break_glass';
}

export interface FleetJitPendingChallenge extends FleetJitChallengeIdentity {
  challengeId: string;
  challenge: string;
  requestNonceDigest: string;
  assurance: FleetJitAssurance;
  binding: FleetJitDurableRequestBinding;
  credentialFloorGeneration: number;
}

export interface FleetJitGrantBinding {
  grantId: string;
  principalId: string;
  browserSessionId: string;
  assurance: FleetJitAssurance;
  credentialFloorGeneration: number;
  expiresAt: Date;
}

export interface FleetJitStepUpStore {
  createChallenge(input: {
    challengeId: string;
    token: string;
    csrfToken: string;
    challenge: string;
    requestNonceDigest: string;
    assurance: FleetJitAssurance;
    binding: FleetJitDurableRequestBinding;
    exactOrigin: string;
    credentialFloorGeneration: number;
    now: Date;
    expiresAt: Date;
  }): Promise<FleetJitChallengeIdentity>;
  prepareChallenge(input: {
    challengeId: string;
    token: string;
    csrfToken: string;
    requestNonceDigest: string;
    exactOrigin: string;
    now: Date;
  }): Promise<FleetJitPendingChallenge>;
  completeChallenge(input: {
    challenge: FleetJitPendingChallenge;
    token: string;
    csrfToken: string;
    completedCredentialFloorGeneration: number;
    now: Date;
    grantExpiresAt: Date;
  }): Promise<FleetJitGrantBinding>;
  cancelChallenge(input: {
    challengeId: string;
    token: string;
    csrfToken: string;
    exactOrigin: string;
    now: Date;
  }): Promise<void>;
  consumeGrant(input: {
    grantId: string;
    token: string;
    exactOrigin: string;
    binding: FleetJitRequestBinding;
    now: Date;
  }): Promise<FleetJitGrantBinding>;
}

export interface DiscordPossessionChallengePort {
  deliver(input: {
    providerSubjectId: string;
    approvalCode: string;
    action: FleetAuthAction;
    companionId: string;
    expiresAt: Date;
  }): Promise<void>;
}

export interface FleetJitStepUpOptions {
  canonicalOrigin: string;
  challengeTtlMs: number;
  grantTtlMs: number;
  store: FleetJitStepUpStore;
  webAuthn: Pick<FleetWebAuthnUvBoundary, 'startAuthentication' | 'finishAuthentication'>;
  readCredentialFloorGeneration(): number;
  discordPossession?: DiscordPossessionChallengePort;
  lowerAssuranceActions?: ReadonlySet<FleetAuthAction>;
  now?: () => Date;
  randomBytes?: (length: number) => Buffer;
  randomUuid?: () => string;
}

export interface StartedFleetJitChallenge {
  challengeId: string;
  requestNonce: string;
  assurance: FleetJitAssurance;
  publicKey?: unknown;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function checkedPurpose(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new FleetJitStepUpError('invalid_request', 'JIT purpose is invalid');
  }
  return normalized;
}

function assertBinding(binding: FleetJitRequestBinding): void {
  if (!isRfc4122Uuid(binding.target.companionId)
    || !DIGEST_PATTERN.test(binding.target.resourceDigest)
    || !DIGEST_PATTERN.test(binding.target.authorizationDigest)
    || !DIGEST_PATTERN.test(binding.target.targetDigest)
    || !DIGEST_PATTERN.test(binding.subjectScopeDigest)
    || !DIGEST_PATTERN.test(binding.classifierEvidenceDigest)
    || binding.target.authorization.action !== binding.target.action
    || !Number.isSafeInteger(binding.memoryRevision)
    || binding.memoryRevision < 1) {
    throw new FleetJitStepUpError('invalid_request', 'JIT request binding is invalid');
  }
  checkedPurpose(binding.purpose);
}

function nonce(randomSource: (length: number) => Buffer): string {
  const value = randomSource(32).toString('base64url');
  if (!OPAQUE_NONCE_PATTERN.test(value)) {
    throw new FleetJitStepUpError('invalid_request', 'JIT random source returned invalid output');
  }
  return value;
}

function isStrongOnly(binding: FleetJitRequestBinding): boolean {
  return binding.target.authorization.requirements.assurance === 'webauthn_uv'
    || binding.target.authorization.requirements.assurance === 'privacy_break_glass';
}

/**
 * Gateway-only orchestration for exact, single-use step-up challenges. It
 * accepts a compiled route target and subject projection, never browser action
 * or resource strings, and leaves all session/role/epoch checks transactional
 * in the store.
 */
export class FleetJitStepUpCoordinator {
  private readonly origin: string;

  constructor(private readonly options: FleetJitStepUpOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.canonicalOrigin);
    } catch {
      throw new FleetJitStepUpError('invalid_request', 'JIT canonical origin is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== options.canonicalOrigin
      || !Number.isSafeInteger(options.challengeTtlMs) || options.challengeTtlMs < 30_000
      || options.challengeTtlMs > 600_000
      || !Number.isSafeInteger(options.grantTtlMs) || options.grantTtlMs < 30_000
      || options.grantTtlMs > 900_000) {
      throw new FleetJitStepUpError('invalid_request', 'JIT configuration is invalid');
    }
    this.origin = parsed.origin;
  }

  async startWebAuthn(input: {
    token: string;
    csrfToken: string;
    requestOrigin: string;
    binding: FleetJitRequestBinding;
  }): Promise<StartedFleetJitChallenge> {
    this.assertOrigin(input.requestOrigin);
    assertBinding(input.binding);
    const generatedChallenge = nonce(this.options.randomBytes ?? randomBytes);
    const requestNonce = nonce(this.options.randomBytes ?? randomBytes);
    const challengeId = (this.options.randomUuid ?? randomUUID)();
    if (!isRfc4122Uuid(challengeId)) {
      throw new FleetJitStepUpError('invalid_request', 'JIT UUID source returned invalid output');
    }
    const now = (this.options.now ?? (() => new Date()))();
    const credentialFloorGeneration = this.options.readCredentialFloorGeneration();
    if (!Number.isSafeInteger(credentialFloorGeneration) || credentialFloorGeneration < 1) {
      throw new FleetJitStepUpError('strong_assurance_required', 'No current passkey authority exists');
    }
    await this.options.store.createChallenge({
      challengeId,
      token: input.token,
      csrfToken: input.csrfToken,
      challenge: generatedChallenge,
      requestNonceDigest: digest(requestNonce),
      assurance: 'webauthn_uv',
      binding: this.durableBinding(input.binding),
      exactOrigin: this.origin,
      credentialFloorGeneration,
      now,
      expiresAt: new Date(now.getTime() + this.options.challengeTtlMs),
    });
    const publicKey = await this.options.webAuthn.startAuthentication({
      challenge: generatedChallenge,
    });
    return { challengeId, requestNonce, assurance: 'webauthn_uv', publicKey };
  }

  async finishWebAuthn(input: {
    challengeId: string;
    requestNonce: string;
    token: string;
    csrfToken: string;
    requestOrigin: string;
    response: unknown;
  }): Promise<FleetJitGrantBinding> {
    this.assertOrigin(input.requestOrigin);
    if (!isRfc4122Uuid(input.challengeId) || !OPAQUE_NONCE_PATTERN.test(input.requestNonce)) {
      throw new FleetJitStepUpError('invalid_request', 'JIT challenge reference is invalid');
    }
    const now = (this.options.now ?? (() => new Date()))();
    const pending = await this.options.store.prepareChallenge({
      challengeId: input.challengeId,
      token: input.token,
      csrfToken: input.csrfToken,
      requestNonceDigest: digest(input.requestNonce),
      exactOrigin: this.origin,
      now,
    });
    if (pending.assurance !== 'webauthn_uv') {
      throw new FleetJitStepUpError('challenge_unavailable', 'JIT challenge method mismatch');
    }
    const verified = await this.options.webAuthn.finishAuthentication({
      response: input.response,
      expectedChallenge: pending.challenge,
      expectedPrincipalId: pending.principalId,
      expectedProviderSubjectId: pending.providerSubjectId,
    });
    return await this.options.store.completeChallenge({
      challenge: pending,
      token: input.token,
      csrfToken: input.csrfToken,
      completedCredentialFloorGeneration: verified.generation,
      now,
      grantExpiresAt: new Date(now.getTime() + this.options.grantTtlMs),
    });
  }

  async startDiscordPossession(input: {
    token: string;
    csrfToken: string;
    requestOrigin: string;
    binding: FleetJitRequestBinding;
  }): Promise<StartedFleetJitChallenge> {
    this.assertOrigin(input.requestOrigin);
    assertBinding(input.binding);
    if (isStrongOnly(input.binding)) {
      throw new FleetJitStepUpError(
        'strong_assurance_required',
        'This action requires a user-verifying passkey',
      );
    }
    if (!this.options.discordPossession
      || !this.options.lowerAssuranceActions?.has(input.binding.target.action)) {
      throw new FleetJitStepUpError(
        'lower_assurance_unavailable',
        'Discord possession approval is not enabled for this action',
      );
    }
    const approvalCode = nonce(this.options.randomBytes ?? randomBytes);
    const requestNonce = nonce(this.options.randomBytes ?? randomBytes);
    const challengeId = (this.options.randomUuid ?? randomUUID)();
    const now = (this.options.now ?? (() => new Date()))();
    const expiresAt = new Date(now.getTime() + this.options.challengeTtlMs);
    const identity = await this.options.store.createChallenge({
      challengeId,
      token: input.token,
      csrfToken: input.csrfToken,
      challenge: approvalCode,
      requestNonceDigest: digest(requestNonce),
      assurance: 'discord_possession',
      binding: this.durableBinding(input.binding),
      exactOrigin: this.origin,
      credentialFloorGeneration: this.options.readCredentialFloorGeneration(),
      now,
      expiresAt,
    });
    await this.options.discordPossession.deliver({
      providerSubjectId: identity.providerSubjectId,
      approvalCode,
      action: input.binding.target.action,
      companionId: input.binding.target.companionId,
      expiresAt,
    });
    return { challengeId, requestNonce, assurance: 'discord_possession' };
  }

  async finishDiscordPossession(input: {
    challengeId: string;
    requestNonce: string;
    approvalCode: string;
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<FleetJitGrantBinding> {
    this.assertOrigin(input.requestOrigin);
    if (!isRfc4122Uuid(input.challengeId) || !OPAQUE_NONCE_PATTERN.test(input.requestNonce)
      || !OPAQUE_NONCE_PATTERN.test(input.approvalCode)) {
      throw new FleetJitStepUpError('invalid_request', 'Discord approval response is invalid');
    }
    const now = (this.options.now ?? (() => new Date()))();
    const pending = await this.options.store.prepareChallenge({
      challengeId: input.challengeId,
      token: input.token,
      csrfToken: input.csrfToken,
      requestNonceDigest: digest(input.requestNonce),
      exactOrigin: this.origin,
      now,
    });
    if (pending.assurance !== 'discord_possession'
      || digest(input.approvalCode) !== digest(pending.challenge)) {
      throw new FleetJitStepUpError('challenge_unavailable', 'Discord approval was denied');
    }
    return await this.options.store.completeChallenge({
      challenge: pending,
      token: input.token,
      csrfToken: input.csrfToken,
      completedCredentialFloorGeneration: pending.credentialFloorGeneration,
      now,
      grantExpiresAt: new Date(now.getTime() + this.options.grantTtlMs),
    });
  }

  cancel(input: {
    challengeId: string;
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<void> {
    this.assertOrigin(input.requestOrigin);
    return this.options.store.cancelChallenge({
      challengeId: input.challengeId,
      token: input.token,
      csrfToken: input.csrfToken,
      exactOrigin: this.origin,
      now: (this.options.now ?? (() => new Date()))(),
    });
  }

  consumeGrant(input: {
    grantId: string;
    token: string;
    requestOrigin: string;
    binding: FleetJitRequestBinding;
  }): Promise<FleetJitGrantBinding> {
    this.assertOrigin(input.requestOrigin);
    assertBinding(input.binding);
    return this.options.store.consumeGrant({
      grantId: input.grantId,
      token: input.token,
      exactOrigin: this.origin,
      binding: input.binding,
      now: (this.options.now ?? (() => new Date()))(),
    });
  }

  private durableBinding(
    binding: FleetJitRequestBinding,
  ): FleetJitDurableRequestBinding {
    return {
      companionId: binding.target.companionId,
      action: binding.target.action,
      resourceDigest: binding.target.resourceDigest,
      authorizationDigest: binding.target.authorizationDigest,
      targetDigest: binding.target.targetDigest,
      subjectScopeDigest: binding.subjectScopeDigest,
      purposeDigest: digest(checkedPurpose(binding.purpose)),
      memoryRevision: binding.memoryRevision,
      classifierEvidenceDigest: binding.classifierEvidenceDigest,
      assuranceRequirement: binding.target.authorization.requirements.assurance,
    };
  }

  private assertOrigin(value: string): void {
    if (value !== this.origin) {
      throw new FleetJitStepUpError('origin_mismatch', 'JIT request origin is invalid');
    }
  }
}

import { createHash } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  assertNoUnknownKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';
import type {
  PasskeyAuthorityCandidate,
  PasskeyAuthorityPort,
} from './passkey-authority.js';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PROVIDER_SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;
const MAX_CREDENTIAL_FIELD_BYTES = 1_048_576;
const AUTHENTICATOR_ATTACHMENTS = ['platform', 'cross-platform'] as const;
const AUTHENTICATOR_TRANSPORTS = [
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
] as const;

export type FleetWebAuthnFailureCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'registration_denied'
  | 'authentication_denied'
  | 'credential_not_current';

export class FleetWebAuthnError extends Error {
  constructor(readonly code: FleetWebAuthnFailureCode, message: string) {
    super(message);
    this.name = 'FleetWebAuthnError';
  }
}

interface VerifiedRegistration {
  verified: boolean;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  userVerified: boolean;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  origin: string;
  rpId: string;
}

interface VerifiedAuthentication {
  verified: boolean;
  credentialId: string;
  newCounter: number;
  userVerified: boolean;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  origin: string;
  rpId: string;
}

export interface FleetWebAuthnCryptoPort {
  generateRegistration(input: {
    rpName: string;
    rpId: string;
    principalId: string;
    challenge: string;
    timeoutMs: number;
  }): Promise<unknown>;
  verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<VerifiedRegistration>;
  generateAuthentication(input: {
    rpId: string;
    challenge: string;
    timeoutMs: number;
  }): Promise<unknown>;
  verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    credential: {
      id: string;
      publicKey: Uint8Array;
      counter: number;
    };
  }): Promise<VerifiedAuthentication>;
}

export const simpleWebAuthnCrypto: FleetWebAuthnCryptoPort = {
  async generateRegistration(input) {
    return await generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpId,
      userName: input.principalId,
      userDisplayName: input.principalId,
      userID: Buffer.from(input.principalId, 'utf8'),
      challenge: input.challenge,
      timeout: input.timeoutMs,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
    });
  },
  async verifyRegistration(input) {
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      expectedType: 'webauthn.create',
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (!result.verified) {
      return {
        verified: false,
        credentialId: input.response.id,
        publicKey: new Uint8Array(),
        counter: 0,
        userVerified: false,
        deviceType: 'singleDevice',
        backedUp: false,
        origin: '',
        rpId: '',
      };
    }
    const info = result.registrationInfo;
    return {
      verified: true,
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      userVerified: info.userVerified,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      origin: info.origin,
      rpId: info.rpID ?? '',
    };
  },
  async generateAuthentication(input) {
    return await generateAuthenticationOptions({
      rpID: input.rpId,
      challenge: input.challenge,
      timeout: input.timeoutMs,
      userVerification: 'required',
    });
  },
  async verifyAuthentication(input) {
    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      expectedType: 'webauthn.get',
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
      credential: {
        ...input.credential,
        publicKey: new Uint8Array(Buffer.from(input.credential.publicKey)),
      },
    });
    return {
      verified: result.verified,
      credentialId: result.authenticationInfo.credentialID,
      newCounter: result.authenticationInfo.newCounter,
      userVerified: result.authenticationInfo.userVerified,
      deviceType: result.authenticationInfo.credentialDeviceType,
      backedUp: result.authenticationInfo.credentialBackedUp,
      origin: result.authenticationInfo.origin,
      rpId: result.authenticationInfo.rpID,
    };
  },
};

function exactString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength
    || !BASE64URL_PATTERN.test(value)) {
    throw new FleetWebAuthnError('invalid_request', `${field} is not bounded base64url`);
  }
  return value;
}

function parseAttachment(value: unknown): 'platform' | 'cross-platform' | undefined {
  if (value === undefined) return undefined;
  if (value === AUTHENTICATOR_ATTACHMENTS[0] || value === AUTHENTICATOR_ATTACHMENTS[1]) return value;
  throw new FleetWebAuthnError('invalid_request', 'authenticatorAttachment is unknown');
}

function parseTransports(value: unknown): Array<typeof AUTHENTICATOR_TRANSPORTS[number]> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > AUTHENTICATOR_TRANSPORTS.length) {
    throw new FleetWebAuthnError('invalid_request', 'WebAuthn transports are invalid');
  }
  const transports = value.map(entry => {
    if (typeof entry !== 'string'
      || !AUTHENTICATOR_TRANSPORTS.includes(entry as typeof AUTHENTICATOR_TRANSPORTS[number])) {
      throw new FleetWebAuthnError('invalid_request', 'WebAuthn transport is unknown');
    }
    return entry as typeof AUTHENTICATOR_TRANSPORTS[number];
  });
  if (new Set(transports).size !== transports.length) {
    throw new FleetWebAuthnError('invalid_request', 'WebAuthn transports contain duplicates');
  }
  return transports;
}

function parseCommon(value: unknown, responseKeys: readonly string[]): {
  record: Record<string, unknown>;
  response: Record<string, unknown>;
  id: string;
  rawId: string;
  authenticatorAttachment?: 'platform' | 'cross-platform';
} {
  if (!isRecord(value)) throw new FleetWebAuthnError('invalid_request', 'WebAuthn response must be an object');
  assertNoUnknownKeys(
    value,
    ['id', 'rawId', 'response', 'authenticatorAttachment', 'clientExtensionResults', 'type'],
    'webauthnResponse',
  );
  if (value.type !== 'public-key' || !isRecord(value.clientExtensionResults)
    || !isRecord(value.response)) {
    throw new FleetWebAuthnError('invalid_request', 'WebAuthn response shape is invalid');
  }
  assertNoUnknownKeys(value.response, responseKeys, 'webauthnResponse.response');
  return {
    record: value,
    response: value.response,
    id: exactString(value.id, 'id', 4096),
    rawId: exactString(value.rawId, 'rawId', 4096),
    ...(parseAttachment(value.authenticatorAttachment)
      ? { authenticatorAttachment: parseAttachment(value.authenticatorAttachment) }
      : {}),
  };
}

export function parseRegistrationResponse(value: unknown): RegistrationResponseJSON {
  const parsed = parseCommon(value, [
    'clientDataJSON',
    'attestationObject',
    'authenticatorData',
    'transports',
    'publicKeyAlgorithm',
    'publicKey',
  ]);
  const response = parsed.response;
  const publicKeyAlgorithm = response.publicKeyAlgorithm;
  if (publicKeyAlgorithm !== undefined
    && (typeof publicKeyAlgorithm !== 'number' || !Number.isSafeInteger(publicKeyAlgorithm))) {
    throw new FleetWebAuthnError('invalid_request', 'publicKeyAlgorithm is invalid');
  }
  return {
    id: parsed.id,
    rawId: parsed.rawId,
    type: 'public-key',
    clientExtensionResults: {},
    ...(parsed.authenticatorAttachment ? { authenticatorAttachment: parsed.authenticatorAttachment } : {}),
    response: {
      clientDataJSON: exactString(response.clientDataJSON, 'clientDataJSON', MAX_CREDENTIAL_FIELD_BYTES),
      attestationObject: exactString(
        response.attestationObject,
        'attestationObject',
        MAX_CREDENTIAL_FIELD_BYTES,
      ),
      ...(response.authenticatorData === undefined ? {} : {
        authenticatorData: exactString(
          response.authenticatorData,
          'authenticatorData',
          MAX_CREDENTIAL_FIELD_BYTES,
        ),
      }),
      ...(parseTransports(response.transports) ? { transports: parseTransports(response.transports) } : {}),
      ...(publicKeyAlgorithm === undefined ? {} : { publicKeyAlgorithm }),
      ...(response.publicKey === undefined ? {} : {
        publicKey: exactString(response.publicKey, 'publicKey', MAX_CREDENTIAL_FIELD_BYTES),
      }),
    },
  };
}

export function parseAuthenticationResponse(value: unknown): AuthenticationResponseJSON {
  const parsed = parseCommon(value, [
    'clientDataJSON',
    'authenticatorData',
    'signature',
    'userHandle',
  ]);
  const response = parsed.response;
  return {
    id: parsed.id,
    rawId: parsed.rawId,
    type: 'public-key',
    clientExtensionResults: {},
    ...(parsed.authenticatorAttachment ? { authenticatorAttachment: parsed.authenticatorAttachment } : {}),
    response: {
      clientDataJSON: exactString(response.clientDataJSON, 'clientDataJSON', MAX_CREDENTIAL_FIELD_BYTES),
      authenticatorData: exactString(
        response.authenticatorData,
        'authenticatorData',
        MAX_CREDENTIAL_FIELD_BYTES,
      ),
      signature: exactString(response.signature, 'signature', MAX_CREDENTIAL_FIELD_BYTES),
      ...(response.userHandle === undefined ? {} : {
        userHandle: exactString(response.userHandle, 'userHandle', 4096),
      }),
    },
  };
}

function validateChallenge(challenge: string): void {
  exactString(challenge, 'challenge', 256);
}

function credentialHash(credentialId: string): string {
  return createHash('sha256').update(Buffer.from(credentialId, 'base64url')).digest('hex');
}

export class FleetWebAuthnUvBoundary {
  private readonly origin: string;
  private readonly rpId: string;
  private readonly rpName: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: {
    canonicalOrigin: string;
    rpId: string;
    rpName: string;
    timeoutMs: number;
    authority: PasskeyAuthorityPort;
    crypto?: FleetWebAuthnCryptoPort;
    now?: () => Date;
  }) {
    let origin: URL;
    try {
      origin = new URL(options.canonicalOrigin);
    } catch {
      throw new FleetWebAuthnError('invalid_configuration', 'WebAuthn canonical origin is invalid');
    }
    if (origin.protocol !== 'https:' || origin.origin !== options.canonicalOrigin
      || origin.hostname !== options.rpId || !options.rpName.trim()
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 10_000
      || options.timeoutMs > 600_000) {
      throw new FleetWebAuthnError('invalid_configuration', 'WebAuthn RP configuration is invalid');
    }
    this.origin = origin.origin;
    this.rpId = options.rpId;
    this.rpName = options.rpName.trim();
    this.timeoutMs = options.timeoutMs;
  }

  async startRegistration(input: { challenge: string; principalId: string }): Promise<unknown> {
    validateChallenge(input.challenge);
    if (!isRfc4122Uuid(input.principalId)) {
      throw new FleetWebAuthnError('invalid_request', 'Passkey principalId is invalid');
    }
    return await (this.options.crypto ?? simpleWebAuthnCrypto).generateRegistration({
      rpName: this.rpName,
      rpId: this.rpId,
      principalId: input.principalId,
      challenge: input.challenge,
      timeoutMs: this.timeoutMs,
    });
  }

  async finishRegistration(input: {
    response: unknown;
    expectedChallenge: string;
    principalId: string;
    expectedProviderSubjectId: string;
  }): Promise<PasskeyAuthorityCandidate> {
    validateChallenge(input.expectedChallenge);
    if (!isRfc4122Uuid(input.principalId)
      || !PROVIDER_SUBJECT_PATTERN.test(input.expectedProviderSubjectId)) {
      throw new FleetWebAuthnError('invalid_request', 'Passkey identity binding is invalid');
    }
    const response = parseRegistrationResponse(input.response);
    const verified = await (this.options.crypto ?? simpleWebAuthnCrypto).verifyRegistration({
      response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.origin,
      expectedRpId: this.rpId,
    });
    if (!verified.verified || !verified.userVerified || verified.origin !== this.origin
      || verified.rpId !== this.rpId || verified.credentialId !== response.id
      || verified.publicKey.byteLength === 0 || !Number.isSafeInteger(verified.counter)
      || verified.counter < 0 || (verified.backedUp && verified.deviceType !== 'multiDevice')) {
      throw new FleetWebAuthnError('registration_denied', 'Passkey registration verification failed');
    }
    return {
      credentialIdHash: credentialHash(verified.credentialId),
      publicKeyVerifier: Buffer.from(verified.publicKey).toString('base64url'),
      rpId: this.rpId,
      principalId: input.principalId,
      expectedProvider: 'discord',
      expectedProviderSubjectId: input.expectedProviderSubjectId,
      signCount: verified.counter,
      backupEligible: verified.deviceType === 'multiDevice',
      backupState: verified.backedUp,
    };
  }

  async startAuthentication(input: { challenge: string }): Promise<unknown> {
    validateChallenge(input.challenge);
    return await (this.options.crypto ?? simpleWebAuthnCrypto).generateAuthentication({
      rpId: this.rpId,
      challenge: input.challenge,
      timeoutMs: this.timeoutMs,
    });
  }

  async finishAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    expectedPrincipalId: string;
    expectedProviderSubjectId: string;
  }): Promise<{ credentialIdHash: string; generation: number }> {
    validateChallenge(input.expectedChallenge);
    if (!isRfc4122Uuid(input.expectedPrincipalId)
      || !PROVIDER_SUBJECT_PATTERN.test(input.expectedProviderSubjectId)) {
      throw new FleetWebAuthnError('invalid_request', 'Passkey identity binding is invalid');
    }
    const response = parseAuthenticationResponse(input.response);
    const idHash = credentialHash(response.id);
    const current = this.options.authority.readPasskeys().credentials.find(entry => (
      entry.credentialIdHash === idHash
      && entry.status === 'current'
      && entry.principalId === input.expectedPrincipalId
      && entry.expectedProviderSubjectId === input.expectedProviderSubjectId
    ));
    if (!current) {
      throw new FleetWebAuthnError('credential_not_current', 'Passkey credential is not current');
    }
    const floorDecision = this.options.authority.verifyCurrentPasskey(current);
    if (!floorDecision.allowed) {
      throw new FleetWebAuthnError('credential_not_current', 'Passkey credential is not current');
    }
    const verified = await (this.options.crypto ?? simpleWebAuthnCrypto).verifyAuthentication({
      response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.origin,
      expectedRpId: this.rpId,
      credential: {
        id: response.id,
        publicKey: Buffer.from(current.publicKeyVerifier, 'base64url'),
        counter: current.signCount,
      },
    });
    if (!verified.verified || !verified.userVerified || verified.origin !== this.origin
      || verified.rpId !== this.rpId || verified.credentialId !== response.id
      || !Number.isSafeInteger(verified.newCounter) || verified.newCounter < current.signCount
      || (verified.backedUp && verified.deviceType !== 'multiDevice')) {
      throw new FleetWebAuthnError('authentication_denied', 'Passkey authentication verification failed');
    }
    const updated = this.options.authority.updateCurrentPasskeySignals({
      credentialIdHash: idHash,
      expectedGeneration: floorDecision.generation,
      signCount: verified.newCounter,
      backupEligible: verified.deviceType === 'multiDevice',
      backupState: verified.backedUp,
      at: (this.options.now ?? (() => new Date()))().toISOString(),
    });
    const after = updated.credentials.find(entry => (
      entry.credentialIdHash === idHash && entry.status === 'current'
    ));
    if (!after) {
      throw new FleetWebAuthnError('credential_not_current', 'Passkey credential changed during verification');
    }
    return { credentialIdHash: idHash, generation: after.generation };
  }
}

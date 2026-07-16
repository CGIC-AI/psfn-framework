export interface PasskeyAuthorityCandidate {
  credentialIdHash: string;
  publicKeyVerifier: string;
  rpId: string;
  principalId: string;
  expectedProvider: 'discord';
  expectedProviderSubjectId: string;
  signCount: number;
  backupEligible: boolean;
  backupState: boolean;
}

export type PasskeyAuthorityStatus = 'current' | 'revoked' | 'replaced' | 'compromised';

export interface PasskeyAuthorityEntry extends PasskeyAuthorityCandidate {
  generation: number;
  status: PasskeyAuthorityStatus;
  createdAt: string;
  revokedAt?: string;
  replacedByCredentialIdHash?: string;
}

export interface PasskeyAuthorityTombstone {
  credentialIdHash: string;
  generation: number;
  status: Exclude<PasskeyAuthorityStatus, 'current'>;
  at: string;
  replacedByCredentialIdHash?: string;
}

export interface PasskeyAuthorityFloor {
  generation: number;
  credentials: PasskeyAuthorityEntry[];
  tombstones: PasskeyAuthorityTombstone[];
}

export type PasskeyVerificationResult =
  | { allowed: true; generation: number }
  | { allowed: false; reason: 'not_found' | 'not_current' | 'metadata_mismatch' };

/**
 * Narrow gateway-owned port over the non-restored passkey authority floor.
 * Fleet-auth PostgreSQL passkey rows are quarantined projections and never
 * implement this authority.
 */
export interface PasskeyAuthorityPort {
  readPasskeys(): PasskeyAuthorityFloor;
  verifyCurrentPasskey(candidate: PasskeyAuthorityCandidate): PasskeyVerificationResult;
  updateCurrentPasskeySignals(input: {
    credentialIdHash: string;
    expectedGeneration: number;
    signCount: number;
    backupEligible: boolean;
    backupState: boolean;
    at: string;
  }): PasskeyAuthorityFloor;
}

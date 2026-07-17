import type { PoolClient } from 'pg';
import type {
  CompanionAuthorityLineageFloor,
  CompanionReaddFloorClaim,
} from './authority-floor.js';

export interface ProviderRevocationAuthorityPort {
  /** Deny database-backed sessions whenever non-restored authority is ahead. */
  sessionAuthorityGenerationIsCurrent(authorityGeneration: number): boolean;
  fence(input: {
    provider: 'discord';
    subjectId: string;
    reasonDigest: string;
    at: Date;
  }): Promise<{
    authorityGeneration: number;
    reconcile(client: PoolClient): Promise<{ globalAuthEpoch: number }>;
  }>;
}

export interface AccountAuthorityFencePort extends ProviderRevocationAuthorityPort {
  recoverProvider(input: {
    principalId: string;
    currentProviderSubjectId: string;
    expectedNewProviderSubjectId: string;
    credentialIdHash: string;
    credentialGeneration: number;
    credentialFloorGeneration: number;
    expectedAuthorityGeneration: number;
    reasonDigest: string;
    at: Date;
  }): Promise<{ authorityGeneration: number }>;
  fenceMany(input: {
    resources: ReadonlyArray<{
      kind: 'provider_subject' | 'contact_binding' | 'role_grant' | 'principal' | 'companion'
        | 'contact_authority_fence';
      resourceId: string;
    }>;
    reasonDigest: string;
    at: Date;
  }): Promise<{ authorityGeneration: number }>;
  beginCompanionReadd(input: {
    companionId: string;
    decisionId: string;
    ceremonyId: string;
    decisionFingerprint: string;
    actorPrincipalId: string;
    target: CompanionReaddFloorClaim;
    priorCompanionVersion: number;
    priorAuthorityGeneration: number;
    priorGlobalAuthEpoch: number;
    reasonDigest: string;
    at: Date;
  }): Promise<CompanionAuthorityLineageFloor>;
  findCompanionReadd(companionId: string): CompanionAuthorityLineageFloor | undefined;
}

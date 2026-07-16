import type { PoolClient } from 'pg';

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
  fenceMany(input: {
    resources: ReadonlyArray<{
      kind: 'provider_subject' | 'contact_binding' | 'role_grant';
      resourceId: string;
    }>;
    reasonDigest: string;
    at: Date;
  }): Promise<{ authorityGeneration: number }>;
}

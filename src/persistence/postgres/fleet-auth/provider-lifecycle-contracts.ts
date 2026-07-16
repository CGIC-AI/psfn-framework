import type { PoolClient } from 'pg';

export interface ProviderRevocationAuthorityPort {
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

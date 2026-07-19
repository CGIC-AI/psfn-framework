export interface EnvCredentialReference {
  kind: 'env';
  envName: string;
}

export type CredentialReference = EnvCredentialReference;

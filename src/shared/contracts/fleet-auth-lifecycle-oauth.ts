import { createHash } from 'node:crypto';

export type LifecycleOAuthAction =
  | 'binding.activate'
  | 'provider.add'
  | 'provider.relink'
  | 'provider.replace'
  | 'provider.unlink'
  | 'principal.merge';

export type LifecycleOAuthProofRole = 'current' | 'new' | 'canonical' | 'source';

export type LifecycleOAuthTransactionKind =
  | 'provider_link'
  | 'provider_replace'
  | 'recovery';

export interface LifecycleOAuthPurpose {
  ceremonyId: string;
  action: LifecycleOAuthAction;
  proofRole: LifecycleOAuthProofRole;
  initiatingPrincipalId: string;
  initiatingSessionId: string;
}

export function lifecycleOAuthKindFor(
  action: LifecycleOAuthAction,
  proofRole: LifecycleOAuthProofRole,
): LifecycleOAuthTransactionKind {
  switch (action) {
    case 'binding.activate':
    case 'provider.add':
      if (proofRole === 'new') return 'provider_link';
      break;
    case 'provider.relink':
      if (proofRole === 'new') return 'recovery';
      break;
    case 'provider.replace':
      if (proofRole === 'current' || proofRole === 'new') return 'provider_replace';
      break;
    case 'provider.unlink':
      if (proofRole === 'current') return 'recovery';
      break;
    case 'principal.merge':
      if (proofRole === 'canonical' || proofRole === 'source') return 'recovery';
      break;
  }
  throw new Error(`Invalid lifecycle OAuth proof role ${proofRole} for ${action}`);
}

export function digestFleetAuthVerifiedProviderProof(input: {
  provider: 'discord';
  subjectId: string;
  callbackTransactionId: string;
}): string {
  return createHash('sha256')
    .update(
      `fleet-auth-verified-provider-proof:v1:${input.provider}:`
      + `${input.subjectId}:${input.callbackTransactionId}`,
    )
    .digest('hex');
}

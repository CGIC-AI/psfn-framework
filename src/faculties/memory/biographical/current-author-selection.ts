import type { ConversationScope } from '../../../core/session/conversation-scope.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import type {
  BiographicalClaim,
  BiographicalSubjectRef,
} from './types.js';

export type CurrentAuthorResolution =
  | {
    readonly status: 'verified';
    readonly subject: BiographicalSubjectRef;
    readonly trustLevel: TrustLevel;
  }
  | { readonly status: 'missing' | 'ambiguous' };

export interface VerifiedCurrentAuthor {
  readonly subject: Extract<BiographicalSubjectRef, { kind: 'contact' }>;
  readonly trustLevel: TrustLevel;
}

function sameSubject(left: BiographicalSubjectRef, right: BiographicalSubjectRef): boolean {
  if (left.kind !== right.kind || left.subjectVersion !== right.subjectVersion) return false;
  return left.kind === 'companion'
    ? right.kind === 'companion' && left.companionId === right.companionId
    : right.kind === 'contact' && left.contactId === right.contactId;
}

/**
 * Resolve the only contact eligible for this tracer. A room roster and recent
 * speakers are deliberately absent from the decision: only the ingress-bound,
 * verified author may select contact claims in a group turn.
 */
export function resolveVerifiedCurrentAuthor(input: {
  readonly conversationScope: ConversationScope;
  readonly currentAuthor?: CurrentAuthorResolution;
}): VerifiedCurrentAuthor | undefined {
  if (input.conversationScope.kind !== 'group') return undefined;
  if (input.currentAuthor?.status !== 'verified') return undefined;
  if (input.currentAuthor.subject.kind !== 'contact') return undefined;
  return {
    subject: input.currentAuthor.subject,
    trustLevel: input.currentAuthor.trustLevel,
  };
}

/**
 * Select active claims whose exact subject pair contains the verified current
 * author and companion. Claim kinds are intentionally not interpreted here;
 * the rendering registry owns that closed vocabulary. This keeps reply/mention
 * subject eligibility and future stable kinds independent of each other.
 */
export async function selectCurrentAuthorClaims(input: {
  readonly store: BiographicalProfileStorePort;
  readonly companionSubject: BiographicalSubjectRef;
  readonly currentAuthor: VerifiedCurrentAuthor;
}): Promise<BiographicalClaim[]> {
  const direct = await input.store.listClaims({
    subject: input.currentAuthor.subject,
    status: 'active',
  });
  const directToCompanion = direct.filter(claim =>
    claim.relatedSubject === undefined
    || sameSubject(claim.relatedSubject, input.companionSubject));

  const companionClaims = await input.store.listClaims({
    subject: input.companionSubject,
    status: 'active',
  });
  const attributedToAuthor = companionClaims.filter(claim =>
    claim.relatedSubject !== undefined
    && sameSubject(claim.relatedSubject, input.currentAuthor.subject));

  const seen = new Set<string>();
  return [...directToCompanion, ...attributedToAuthor].filter(claim => {
    if (seen.has(claim.id)) return false;
    seen.add(claim.id);
    return true;
  });
}

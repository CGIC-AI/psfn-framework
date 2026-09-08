// ── Biography synthesis target selection (o61vb.12) ──
//
// Who gets mined for durable candidates is a runtime authority decision, never
// a model or channel decision. Two rules govern it:
//
//   * The companion's own autobiography is always in scope at `full` depth.
//   * A canonical contact enters scope only at `developing` or `full` collection
//     depth, computed by the shared `deriveBiographicalCollectionDepth` policy
//     from verified canonical-contact, trust and relationship evidence. A
//     recognition-depth contact keeps only its freshness-bound Recent Contact
//     Shape and is never mined for atomic claims.
//
// Depth controls compute and retention here, never sensitivity or disclosure:
// admission of any individual source still runs through owner candidate policy.

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact, RelationshipType } from '../../../core/contacts/types.js';
import type { BiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import { HIGH_TIER_TRUST_LEVELS, type TrustLevel } from '../../../system/trust/types.js';
import { deriveBiographicalCollectionDepth } from './depth-policy.js';
import type { VerifiedContactDepthEvidence } from './depth-policy.js';
import type {
  BiographySynthesisTarget,
  BiographySynthesisTargetPort,
} from './synthesis-service.js';
import type { BiographicalSubjectRef } from './types.js';

/**
 * Relationship types the depth policy recognizes. `acquaintance`, `stranger`
 * and `ai_companion` map to `other`, which never on its own reaches full depth.
 */
function depthRelationshipType(
  relationshipType: RelationshipType,
): NonNullable<VerifiedContactDepthEvidence['relationship']>['type'] {
  if (relationshipType === 'partner' || relationshipType === 'family'
    || relationshipType === 'friend') {
    return relationshipType;
  }
  return 'other';
}

/**
 * Trust levels worth enumerating. Depth requires at least `regular` trust, and
 * only a verified high-tier contact can reach developing or full, so the scan
 * never walks the entire contact table.
 */
const SCANNED_TRUST_LEVELS: readonly TrustLevel[] = HIGH_TIER_TRUST_LEVELS;

export function createBiographySynthesisTargetPort(input: {
  readonly contactStore: ContactStorePort;
  readonly companionSubject: Extract<BiographicalSubjectRef, { kind: 'companion' }>;
  readonly depthPolicy: () => BiographicalDepthPolicy;
}): BiographySynthesisTargetPort {
  const contactEvidence = async (
    contact: Contact,
  ): Promise<VerifiedContactDepthEvidence> => {
    const subject: Extract<BiographicalSubjectRef, { kind: 'contact' }> = {
      kind: 'contact',
      contactId: contact.id,
      subjectVersion: 1,
    };
    const verifiedLinks = await input.contactStore.countVerifiedIdentityLinks(contact.id);
    const authorityRef = `contact-store:${contact.id}`;
    return {
      subject,
      canonicalContactVerified: contact.archivedAt === undefined && verifiedLinks > 0,
      trust: { verified: true, level: contact.trustLevel, authorityRef },
      relationship: {
        verified: true,
        type: depthRelationshipType(contact.relationshipType),
        authorityRef,
      },
      // Governed-context evidence is owned by the participation authority and
      // is not available to this lane; without it a contact reaches developing
      // or full only through verified relationship and trust.
      governedContexts: [],
    };
  };

  return {
    listTargets: async limit => {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('biography synthesis target limit must be a positive safe integer');
      }
      const policy = input.depthPolicy();
      const targets: BiographySynthesisTarget[] = [{
        subject: input.companionSubject,
        socialContext: {
          kind: 'companion_self',
          companionId: input.companionSubject.companionId,
        },
        depth: 'full',
      }];
      const seen = new Set<string>();
      for (const trustLevel of SCANNED_TRUST_LEVELS) {
        if (targets.length >= limit) break;
        for (const contact of await input.contactStore.getByTrustLevel(trustLevel)) {
          if (targets.length >= limit) break;
          if (contact.archivedAt !== undefined || seen.has(contact.id)) continue;
          seen.add(contact.id);
          const evidence = await contactEvidence(contact);
          const depth = deriveBiographicalCollectionDepth({
            subject: evidence.subject,
            contactEvidence: evidence,
            policy,
          });
          if (depth === 'recognition') continue;
          targets.push({
            subject: evidence.subject,
            socialContext: {
              kind: 'companion_contact_dyad',
              companionId: input.companionSubject.companionId,
              contactId: contact.id,
            },
            depth,
          });
        }
      }
      return targets;
    },
  };
}

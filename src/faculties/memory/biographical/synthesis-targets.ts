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
import { deriveBiographicalCollectionDepth, hasAuthorityRef } from './depth-policy.js';
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

/**
 * One verified group the companion belongs to (psfn-framework-uz787).
 *
 * Membership is a governance fact, exactly like canonical-contact and
 * relationship evidence: it must come from an authority that can vouch for the
 * exact participant set. A room roster, a channel label or model output are
 * deliberately NOT acceptable inputs — an n-ary claim binds real people, and
 * getting the set wrong writes a durable fact about someone who was never
 * there.
 */
export interface VerifiedBiographyGroupMembership {
  /** Stable id of the governed context this membership comes from. */
  readonly contextId: string;
  /** `authority:id` reference for the source that vouches for the membership. */
  readonly governanceAuthorityRef: string;
  readonly verified: boolean;
  /** Canonical contact ids, at least two, that make up the group. */
  readonly contactIds: readonly string[];
}

/**
 * The seam a future group-membership authority plugs into.
 *
 * NOTHING implements this today: no production source can currently vouch for a
 * canonical group membership, which is why `deriveBiographicalCollectionDepth`
 * still receives `governedContexts: []` below. Until an implementation exists,
 * `createBiographySynthesisTargetPort` is constructed without it and group
 * synthesis is OFF: zero group targets, zero group candidates. That is the
 * fail-closed default, not a gap to be filled by a heuristic.
 */
export interface BiographyGroupMembershipAuthorityPort {
  /** Verified groups the companion is a member of, bounded by `limit`. */
  listVerifiedGroups(limit: number): Promise<readonly VerifiedBiographyGroupMembership[]>;
}

/**
 * Canonicalize and validate one membership before it can become a target.
 * Anything unverified, under-sized, duplicated, unreferenced or blank is
 * dropped rather than repaired: a group fact built on an uncertain set is worse
 * than no group fact.
 */
function admissibleGroupContactIds(
  membership: VerifiedBiographyGroupMembership,
): readonly string[] | null {
  if (!membership.verified) return null;
  if (!hasAuthorityRef(membership.governanceAuthorityRef)) return null;
  if (membership.contextId.trim().length === 0) return null;
  const contactIds = membership.contactIds.map(id => id.trim()).filter(id => id.length > 0);
  const unique = [...new Set(contactIds)].sort((left, right) => left.localeCompare(right));
  // Two is what makes a set a group rather than a dyad — the claim shape's own
  // definition (`assertParticipantSet`), mirrored here so an inadmissible
  // membership never reaches the synthesizer at all.
  if (unique.length !== contactIds.length || unique.length < 2) return null;
  return unique;
}

export function createBiographySynthesisTargetPort(input: {
  readonly contactStore: ContactStorePort;
  readonly companionSubject: Extract<BiographicalSubjectRef, { kind: 'companion' }>;
  readonly depthPolicy: () => BiographicalDepthPolicy;
  /**
   * uz787: absent (the production default today) means no group targets at all.
   * Group synthesis exists only when an authority vouches for the membership.
   */
  readonly groupMembershipAuthority?: BiographyGroupMembershipAuthorityPort;
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
      // uz787: group targets exist only where an authority vouches for the
      // exact membership. With no authority wired this loop does not run and
      // the pass is byte-identical to the pre-uz787 behavior.
      const authority = input.groupMembershipAuthority;
      if (authority !== undefined && targets.length < limit) {
        for (const membership of await authority.listVerifiedGroups(limit - targets.length)) {
          if (targets.length >= limit) break;
          const contactIds = admissibleGroupContactIds(membership);
          if (contactIds === null) continue;
          targets.push({
            // A group claim is anchored on the companion subject and binds its
            // participants explicitly; it is never a claim ABOUT one member.
            subject: input.companionSubject,
            socialContext: {
              kind: 'companion_group',
              companionId: input.companionSubject.companionId,
              contactIds,
            },
            // Group evidence is collected from the companion's own silo at the
            // same depth her autobiography uses; per-source admission still
            // runs through owner candidate policy unchanged.
            depth: 'full',
          });
        }
      }
      return targets;
    },
  };
}

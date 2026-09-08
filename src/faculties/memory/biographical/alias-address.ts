// ── Relationship-scoped biography aliases as passive room address (o61vb.17) ──
//
// A companion addressed in a group room by a nickname its partner actually uses
// should be able to notice, without an @mention and without the nickname
// becoming public. This module answers exactly one question for one message:
// which reviewed aliases may THIS speaker use for THIS companion?
//
// What it deliberately is not:
//   - it is not a matcher. The single canonical `detectCompanionNameMatch`
//     still decides what counts as being named; this only supplies the alias
//     list it matches against.
//   - it is not a disclosure. A resolved alias is compared against message text
//     and discarded; nothing about it is rendered, logged, or reported. An
//     unrelated speaker simply gets an empty list, which is telemetry-identical
//     to a companion that has no aliases at all.
//   - it is not an authority. A match is a passive participation candidate; the
//     appraiser, room arbiter, debounce, fatigue, autonomy and CogSec gates are
//     all still downstream and unchanged.
//
// Eligibility mirrors the portable projection's own rules rather than
// reimplementing them: the claim must be an active nickname, its sources must
// revalidate now, and its reviewed portability must actually authorize reaching
// this speaker.

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { BiographicalSourceRevalidator } from './projection.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import type { BiographicalClaim, BiographicalSubjectRef } from './types.js';

/**
 * Aliases one verified speaker may use to address the companion. Ordered and
 * deduplicated by the caller; the strings are compared against message text and
 * never rendered.
 */
export interface BiographicalAliasResolver {
  resolve(input: {
    /** Transport the observed author id belongs to (`discord`, `matrix`, …). */
    readonly source: string;
    /** Transport-authoritative author id. Display names are never accepted. */
    readonly transportParticipantId: string;
  }): Promise<readonly string[]>;
}

/**
 * Which reviewed nickname claims a given verified contact may address the
 * companion by.
 *
 * - `universal` self-nicknames are the companion's own reviewed baseline
 *   identity: she published them, so anyone may use them.
 * - `subject_present` relational nicknames belong to one relationship. They are
 *   valid only for the exact contact they are bound to, which is what stops an
 *   unrelated speaker in the same room from using — or discovering — a private
 *   term of address.
 *
 * Anything else, including every `origin_only` claim, contributes nothing.
 */
function aliasForSpeaker(
  claim: BiographicalClaim,
  speakerContactId: string,
): string | undefined {
  if (claim.kind !== 'nickname' || claim.status !== 'active') return undefined;
  if (claim.value.kind !== 'nickname') return undefined;
  if (claim.participants !== undefined) return undefined;
  if (claim.subject.kind !== 'companion') return undefined;
  if (claim.portabilityScope === 'universal') {
    return claim.relatedSubject === undefined && claim.value.scope === 'self'
      ? claim.value.nickname
      : undefined;
  }
  if (claim.portabilityScope !== 'subject_present') return undefined;
  return claim.relatedSubject?.kind === 'contact'
    && claim.relatedSubject.contactId === speakerContactId
    ? claim.value.nickname
    : undefined;
}

export interface BiographicalAliasResolverOptions {
  readonly store: BiographicalProfileStorePort;
  readonly contactStore: ContactStorePort;
  readonly revalidator: BiographicalSourceRevalidator;
  readonly companionSubject: Extract<BiographicalSubjectRef, { kind: 'companion' }>;
  /** Owner-file floor; a shorter alias is never a safe summons. */
  readonly minAliasLength: number;
  readonly now?: () => Date;
}

/**
 * Build the per-message alias resolver.
 *
 * Every gate here fails closed: an unverified or archived speaker, a claim
 * whose sources no longer revalidate, an alias below the owner-file length
 * floor, or an alias that collides with a canonical companion name all resolve
 * to nothing rather than to a weaker match.
 */
export function createBiographicalAliasResolver(
  options: BiographicalAliasResolverOptions,
): BiographicalAliasResolver {
  return {
    resolve: async input => {
      const contact = await options.contactStore.getByChannelIdentity(
        input.source,
        input.transportParticipantId,
      );
      // An unverified speaker is not in any relationship, so there is nothing
      // relationship-scoped for them to say.
      if (!contact || contact.archivedAt) return [];
      const claims = await options.store.listClaims({
        subject: options.companionSubject,
        kind: 'nickname',
        status: 'active',
      });
      const now = options.now?.() ?? new Date();
      const aliases: string[] = [];
      const seen = new Set<string>();
      for (const claim of claims) {
        const alias = aliasForSpeaker(claim, contact.id);
        if (alias === undefined) continue;
        if (alias.trim().length < options.minAliasLength) continue;
        if (seen.has(alias)) continue;
        // The same read-time source revalidation the portable projection
        // applies. A quarantined, tombstoned, revoked or vanished source
        // withdraws the alias immediately, without a separate lifecycle path.
        const revalidation = await options.revalidator.revalidate(claim.sources, now);
        if (revalidation.status !== 'valid') continue;
        seen.add(alias);
        aliases.push(alias);
      }
      return aliases;
    },
  };
}

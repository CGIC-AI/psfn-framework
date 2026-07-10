// ── Source-list matching + source-risk tier adjustment (htm9.13) ──
//
// Operator-curated trusted/denied lists (intake-policy.json `sourceLists`,
// fed by the Garden flywheel htm9.11) scale screening scrutiny by SOURCE
// risk, not just static sender trust:
//   - a trusted-site/person hit lowers the effective source risk tier ONE
//     step (never below 'trusted', never skipping L1 — deterministic
//     scanning always runs; trusted origin != safe, see npm/GitHub
//     supply-chain attacks);
//   - a denied-site/person hit raises the tier to 'hostile' (mandatory deep
//     screening under the default policy).
// The adjusted tier is what the L1.5/L2/L3 escalation thresholds and the
// sink gates consume, so a trusted-list hit measurably skips the expensive
// escalation layers while a denied hit forces them.
//
// Matching is deliberately dumb and fail-closed: sites match by exact host
// or a '*.domain.tld' registrable-domain suffix (validated at config load —
// no regex from config), people match by exact canonical contact id. A
// denied hit always wins over a trusted hit.

import {
  INTAKE_SOURCE_RISK_TIERS,
  type IntakeSourceRiskTier,
} from '../../../shared/contracts/intake-envelope.js';
import type {
  IntakeSourceListName,
  IntakeSourceListsConfig,
} from '../../../system/config/intake-policy-config.js';

export interface IntakeSourceListMatch {
  kind: 'trusted' | 'denied';
  list: IntakeSourceListName;
  /** The list pattern that matched. */
  pattern: string;
  /** What was matched against (the host or the canonical contact id). */
  subject: string;
}

/**
 * Extracts a lowercase hostname from an origin ref when it is an http(s)
 * URL; returns null for every other ref shape (tool call ids,
 * `discord:<channel>:<message>` locators, ...). Site lists only ever apply
 * to URL-shaped origins.
 */
export function extractHostFromOriginRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!/^https?:\/\//iu.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  return host.length > 0 ? host : null;
}

/** Exact host or '*.domain.tld' suffix match ('*.x.y' matches 'x.y' and '*.x.y'). */
export function intakeSitePatternMatchesHost(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

function findSiteMatch(
  lists: IntakeSourceListsConfig,
  list: Extract<IntakeSourceListName, 'trustedSites' | 'deniedSites'>,
  host: string,
): IntakeSourceListMatch | null {
  for (const entry of lists[list]) {
    if (intakeSitePatternMatchesHost(entry.pattern, host)) {
      return {
        kind: list === 'deniedSites' ? 'denied' : 'trusted',
        list,
        pattern: entry.pattern,
        subject: host,
      };
    }
  }
  return null;
}

function findPersonMatch(
  lists: IntakeSourceListsConfig,
  list: Extract<IntakeSourceListName, 'trustedPeople' | 'deniedPeople'>,
  contactId: string,
): IntakeSourceListMatch | null {
  for (const entry of lists[list]) {
    if (entry.pattern === contactId) {
      return {
        kind: list === 'deniedPeople' ? 'denied' : 'trusted',
        list,
        pattern: entry.pattern,
        subject: contactId,
      };
    }
  }
  return null;
}

export interface MatchIntakeSourceListsInput {
  lists: IntakeSourceListsConfig;
  /** Origin locator; site lists apply only when it parses as an http(s) URL. */
  originRef: string;
  /** Canonical contact id of the sender, when the surface knows one. */
  canonicalContactId?: string;
}

/**
 * Matches an item's origin against the source lists. Denied hits win over
 * trusted hits (fail closed); within a kind, site and person matches are
 * checked in that order.
 */
export function matchIntakeSourceLists(
  input: MatchIntakeSourceListsInput,
): IntakeSourceListMatch | null {
  const host = extractHostFromOriginRef(input.originRef);
  const contactId = input.canonicalContactId?.trim();

  // Denied always wins over trusted.
  if (host) {
    const denied = findSiteMatch(input.lists, 'deniedSites', host);
    if (denied) return denied;
  }
  if (contactId) {
    const denied = findPersonMatch(input.lists, 'deniedPeople', contactId);
    if (denied) return denied;
  }
  if (host) {
    const trusted = findSiteMatch(input.lists, 'trustedSites', host);
    if (trusted) return trusted;
  }
  if (contactId) {
    const trusted = findPersonMatch(input.lists, 'trustedPeople', contactId);
    if (trusted) return trusted;
  }
  return null;
}

export interface AdjustedSourceRiskTier {
  tier: IntakeSourceRiskTier;
  /** Present only when a list hit changed the tier. */
  adjustment?: {
    match: IntakeSourceListMatch;
    from: IntakeSourceRiskTier;
    /** 'lowered_one_step' (trusted hit) or 'raised_to_hostile' (denied hit). */
    kind: 'lowered_one_step' | 'raised_to_hostile';
  };
}

/**
 * Applies the source-list tier adjustment: a trusted hit lowers the tier
 * exactly ONE step (floor 'trusted'), a denied hit raises it to 'hostile'.
 * Returns the base tier unchanged when there is no match or the match is a
 * no-op (already at the floor/ceiling).
 */
export function adjustSourceRiskTierForSourceLists(
  baseTier: IntakeSourceRiskTier,
  match: IntakeSourceListMatch | null,
): AdjustedSourceRiskTier {
  if (!match) return { tier: baseTier };
  if (match.kind === 'denied') {
    if (baseTier === 'hostile') return { tier: baseTier };
    return {
      tier: 'hostile',
      adjustment: { match, from: baseTier, kind: 'raised_to_hostile' },
    };
  }
  const index = INTAKE_SOURCE_RISK_TIERS.indexOf(baseTier);
  if (index <= 0) return { tier: baseTier };
  return {
    tier: INTAKE_SOURCE_RISK_TIERS[index - 1],
    adjustment: { match, from: baseTier, kind: 'lowered_one_step' },
  };
}

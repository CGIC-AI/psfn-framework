import type {
  BiographicalClaim,
  NameClaimValue,
  NicknameClaimValue,
  RelationshipClaimValue,
  RoleClaimValue,
  SharedLanguageClaimValue,
  StablePreferenceClaimValue,
} from './types.js';

export type BiographicalClaimAudienceRole = 'companion-self' | 'current-author';

export interface BiographicalClaimPresentation {
  readonly claim: BiographicalClaim;
  readonly section: 'companion-self' | 'current-author-identity' | 'current-author-relational';
  readonly header: string;
  readonly line: string;
  readonly sortKey: string;
}

interface BiographicalClaimRenderer {
  readonly matches: (
    claim: BiographicalClaim,
    audienceRole: BiographicalClaimAudienceRole,
  ) => boolean;
  readonly present: (claim: BiographicalClaim) => BiographicalClaimPresentation;
}

const SELF_HEADER = '## Companion self-shape\nSelf-nicknames the companion has approved for this audience; she may recognize them when addressed by them:';
const CURRENT_AUTHOR_IDENTITY_HEADER = '## Current author identity';
const CURRENT_AUTHOR_RELATIONAL_HEADER = '## Current author relational attribution';

function normalizeForOrder(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isSelfNickname(claim: BiographicalClaim): boolean {
  return claim.kind === 'nickname'
    && claim.subject.kind === 'companion'
    && claim.relatedSubject === undefined
    && claim.value.kind === 'nickname'
    && claim.value.scope === 'self';
}

function isCurrentAuthorName(claim: BiographicalClaim): boolean {
  return claim.kind === 'name'
    && claim.subject.kind === 'contact'
    && claim.relatedSubject === undefined
    && claim.value.kind === 'name';
}

function isCurrentAuthorRelationship(claim: BiographicalClaim): boolean {
  return claim.kind === 'relationship'
    && claim.subject.kind === 'contact'
    && claim.relatedSubject?.kind === 'companion'
    && claim.value.kind === 'relationship';
}

function isCurrentAuthorRelationalNickname(claim: BiographicalClaim): boolean {
  return claim.kind === 'nickname'
    && claim.subject.kind === 'companion'
    && claim.relatedSubject?.kind === 'contact'
    && claim.value.kind === 'nickname'
    && claim.value.scope === 'relational';
}

function isRole(claim: BiographicalClaim, subjectKind: 'companion' | 'contact'): boolean {
  return claim.kind === 'role'
    && claim.subject.kind === subjectKind
    && claim.relatedSubject === undefined
    && claim.value.kind === 'role';
}

function isStablePreference(
  claim: BiographicalClaim,
  subjectKind: 'companion' | 'contact',
): boolean {
  return claim.kind === 'stable-preference'
    && claim.subject.kind === subjectKind
    && claim.relatedSubject === undefined
    && claim.value.kind === 'stable-preference';
}

function isCurrentAuthorSharedLanguage(claim: BiographicalClaim): boolean {
  return claim.kind === 'shared-language'
    && claim.subject.kind === 'contact'
    && claim.relatedSubject?.kind === 'companion'
    && claim.value.kind === 'shared-language';
}

function isBiographicalClaimCurrent(claim: BiographicalClaim, now: Date): boolean {
  if (claim.status !== 'active') return false;
  const nowMs = now.getTime();
  if (claim.validFrom !== undefined && Date.parse(claim.validFrom) > nowMs) return false;
  if (claim.validTo !== undefined && Date.parse(claim.validTo) <= nowMs) return false;
  return true;
}

function renderRole(value: RoleClaimValue): string {
  return value.organization === undefined
    ? `${value.roleType}: ${value.title}`
    : `${value.roleType}: ${value.title} at ${value.organization}`;
}

/** Closed deterministic rendering registry. Subject eligibility is resolved
 * before this registry runs, so adding a stable kind does not alter who may be
 * selected and adding a subject role does not alter kind rendering. */
const BIOGRAPHICAL_CLAIM_RENDERERS: readonly BiographicalClaimRenderer[] = [
  {
    matches: (claim, audienceRole) => audienceRole === 'companion-self' && isSelfNickname(claim),
    present: claim => {
      const value = claim.value as NicknameClaimValue;
      return {
        claim,
        section: 'companion-self',
        header: SELF_HEADER,
        line: `- ${value.nickname}`,
        sortKey: `companion-self:${normalizeForOrder(value.nickname)}`,
      };
    },
  },
  {
    matches: (claim, audienceRole) =>
      audienceRole === 'companion-self' && isRole(claim, 'companion'),
    present: claim => {
      const value = claim.value as RoleClaimValue;
      return {
        claim,
        section: 'companion-self',
        header: SELF_HEADER,
        line: `- Current role — ${renderRole(value)}`,
        sortKey: `companion-self:role:${value.roleType}:${normalizeForOrder(value.organization ?? '')}:${normalizeForOrder(value.title)}`,
      };
    },
  },
  {
    matches: (claim, audienceRole) =>
      audienceRole === 'companion-self' && isStablePreference(claim, 'companion'),
    present: claim => {
      const value = claim.value as StablePreferenceClaimValue;
      return {
        claim,
        section: 'companion-self',
        header: SELF_HEADER,
        line: `- ${value.polarity} ${value.target} (${value.domain})`,
        sortKey: `companion-self:preference:${value.domain}:${normalizeForOrder(value.target)}:${value.polarity}`,
      };
    },
  },
  {
    matches: (claim, audienceRole) => audienceRole === 'current-author' && isCurrentAuthorName(claim),
    present: claim => {
      const value = claim.value as NameClaimValue;
      return {
        claim,
        section: 'current-author-identity',
        header: CURRENT_AUTHOR_IDENTITY_HEADER,
        line: `- ${value.role === 'primary' ? 'Primary name' : 'Alias'}: ${value.name}`,
        sortKey: `current-author:identity:name:${value.role === 'primary' ? 'primary' : 'secondary'}:${normalizeForOrder(value.name)}`,
      };
    },
  },
  {
    matches: (claim, audienceRole) =>
      audienceRole === 'current-author' && isRole(claim, 'contact'),
    present: claim => {
      const value = claim.value as RoleClaimValue;
      return {
        claim,
        section: 'current-author-identity',
        header: CURRENT_AUTHOR_IDENTITY_HEADER,
        line: `- Current role — ${renderRole(value)}`,
        sortKey: `current-author:identity:role:${value.roleType}:${normalizeForOrder(value.organization ?? '')}:${normalizeForOrder(value.title)}`,
      };
    },
  },
  {
    matches: (claim, audienceRole) =>
      audienceRole === 'current-author' && isStablePreference(claim, 'contact'),
    present: claim => {
      const value = claim.value as StablePreferenceClaimValue;
      return {
        claim,
        section: 'current-author-identity',
        header: CURRENT_AUTHOR_IDENTITY_HEADER,
        line: `- Stable preference: ${value.polarity} ${value.target} (${value.domain})`,
        sortKey: `current-author:identity:preference:${value.domain}:${normalizeForOrder(value.target)}:${value.polarity}`,
      };
    },
  },
  {
    matches: (claim, audienceRole) =>
      audienceRole === 'current-author' && isCurrentAuthorRelationship(claim),
    present: claim => {
      const value = claim.value as RelationshipClaimValue;
      return {
        claim,
        section: 'current-author-identity',
        header: CURRENT_AUTHOR_IDENTITY_HEADER,
        line: `- Relationship to the companion: ${value.relationshipType}`,
        sortKey: `current-author:identity:relationship:${normalizeForOrder(value.relationshipType)}`,
      };
    },
  },
  {
    matches: (claim, audienceRole) =>
      audienceRole === 'current-author' && isCurrentAuthorRelationalNickname(claim),
    present: claim => {
      const value = claim.value as NicknameClaimValue;
      return {
        claim,
        section: 'current-author-relational',
        header: CURRENT_AUTHOR_RELATIONAL_HEADER,
        line: `- The current author calls the companion “${value.nickname}”.`,
        sortKey: `current-author:relational:nickname:${normalizeForOrder(value.nickname)}`,
      };
    },
  },
  {
    matches: (claim, audienceRole) =>
      audienceRole === 'current-author' && isCurrentAuthorSharedLanguage(claim),
    present: claim => {
      const value = claim.value as SharedLanguageClaimValue;
      return {
        claim,
        section: 'current-author-relational',
        header: CURRENT_AUTHOR_RELATIONAL_HEADER,
        line: `- Shared ${value.languageType} “${value.phrase}” means ${value.meaning}.`,
        sortKey: `current-author:relational:shared-language:${value.languageType}:${normalizeForOrder(value.phrase)}`,
      };
    },
  },
];

export function presentBiographicalClaim(
  claim: BiographicalClaim,
  audienceRole: BiographicalClaimAudienceRole,
  now: Date = new Date(),
): BiographicalClaimPresentation | undefined {
  if (!isBiographicalClaimCurrent(claim, now)) return undefined;
  return BIOGRAPHICAL_CLAIM_RENDERERS
    .find(renderer => renderer.matches(claim, audienceRole))
    ?.present(claim);
}

function compareBiographicalPresentations(
  left: BiographicalClaimPresentation,
  right: BiographicalClaimPresentation,
): number {
  if (left.sortKey !== right.sortKey) return left.sortKey < right.sortKey ? -1 : 1;
  return left.claim.claimDigest < right.claim.claimDigest
    ? -1
    : left.claim.claimDigest > right.claim.claimDigest ? 1 : 0;
}

export function renderBiographicalPresentations(
  presentations: readonly BiographicalClaimPresentation[],
): string {
  if (presentations.length === 0) return '';
  const sorted = [...presentations].sort(compareBiographicalPresentations);
  const lines: string[] = [];
  let section: BiographicalClaimPresentation['section'] | undefined;
  for (const presentation of sorted) {
    if (presentation.section !== section) {
      lines.push(presentation.header);
      section = presentation.section;
    }
    lines.push(presentation.line);
  }
  return `${lines.join('\n')}\n`;
}

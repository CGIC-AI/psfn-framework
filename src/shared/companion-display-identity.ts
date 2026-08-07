import { isRfc4122Uuid } from './utils/types.js';

/**
 * Display-only companion identity. Stable ids remain the sole routing and
 * authority keys; these labels are safe projections for people and companions.
 */
export interface CompanionDisplayRosterEntry {
  readonly companionId: string;
  readonly displayName?: string;
}

interface CompanionDisplayIdentity {
  readonly companionId: string;
  /** Canonical roster name, or the explicit unknown label when it is absent. */
  readonly displayName: string;
  /** Primary UI label, disambiguated when names collide. */
  readonly displayLabel: string;
  /** Exact stable id for an explicit technical-details surface. */
  readonly technicalLabel: string;
  /** True only when the roster contains a usable canonical display name. */
  readonly known: boolean;
}

interface CompanionDisplayIdentityResolver {
  resolve(companionId: string): CompanionDisplayIdentity;
  resolveMany(companionIds: Iterable<string>): Readonly<Record<string, CompanionDisplayIdentity>>;
}

export const UNKNOWN_COMPANION_DISPLAY_NAME = 'Unknown companion';

function normalizeCompanionId(companionId: string): string {
  const normalized = companionId.trim();
  if (!normalized) throw new Error('Companion display identity requires a non-empty companionId');
  return normalized;
}

function normalizeDisplayName(displayName: string | undefined): string | null {
  const normalized = displayName?.trim();
  return normalized ? normalized : null;
}

function distinguishingTechnicalSuffix(
  companionId: string,
  peerCompanionIds: readonly string[],
): string {
  const uuidCandidate: unknown = companionId;
  const minimumLength = isRfc4122Uuid(uuidCandidate)
    ? companionId.indexOf('-')
    : companionId.length;
  for (let length = minimumLength; length <= companionId.length; length += 1) {
    const candidate = companionId.slice(0, length);
    if (peerCompanionIds.every(peerId => peerId === companionId || !peerId.startsWith(candidate))) {
      return candidate;
    }
  }
  return companionId;
}

/**
 * Builds one roster-scoped resolver so every projection makes the same honest
 * choice for missing and duplicate names. The result never carries authority.
 */
export function createCompanionDisplayIdentityResolver(
  roster: readonly CompanionDisplayRosterEntry[],
): CompanionDisplayIdentityResolver {
  const namesByCompanionId = new Map<string, string | null>();
  const nameCounts = new Map<string, number>();
  const companionIdsByName = new Map<string, string[]>();
  const unnamedCompanionIds: string[] = [];
  const normalizedRoster: CompanionDisplayRosterEntry[] = [];

  for (const entry of roster) {
    const companionId = normalizeCompanionId(entry.companionId);
    if (namesByCompanionId.has(companionId)) {
      throw new Error(`Companion display identity roster contains duplicate id ${companionId}`);
    }
    const displayName = normalizeDisplayName(entry.displayName);
    namesByCompanionId.set(companionId, displayName);
    normalizedRoster.push({
      companionId,
      ...(displayName ? { displayName } : {}),
    });
    if (displayName) {
      const comparisonKey = displayName.toLocaleLowerCase('en-US');
      nameCounts.set(comparisonKey, (nameCounts.get(comparisonKey) ?? 0) + 1);
      const companionIds = companionIdsByName.get(comparisonKey) ?? [];
      companionIds.push(companionId);
      companionIdsByName.set(comparisonKey, companionIds);
    } else {
      unnamedCompanionIds.push(companionId);
    }
  }

  const resolve = (rawCompanionId: string): CompanionDisplayIdentity => {
    const companionId = normalizeCompanionId(rawCompanionId);
    const displayName = namesByCompanionId.get(companionId) ?? null;
    const known = displayName !== null;
    const resolvedName = displayName ?? UNKNOWN_COMPANION_DISPLAY_NAME;
    const duplicate = displayName !== null
      && (nameCounts.get(displayName.toLocaleLowerCase('en-US')) ?? 0) > 1;
    const peerCompanionIds = displayName === null
      ? unnamedCompanionIds
      : companionIdsByName.get(displayName.toLocaleLowerCase('en-US')) ?? [];
    const displayLabel = !known || duplicate
      ? `${resolvedName} · ${distinguishingTechnicalSuffix(companionId, peerCompanionIds)}`
      : resolvedName;
    return Object.freeze({
      companionId,
      displayName: resolvedName,
      displayLabel,
      technicalLabel: `Companion ID ${companionId}`,
      known,
    });
  };

  return Object.freeze({
    resolve,
    resolveMany(companionIds: Iterable<string>) {
      const requestedIds = [...new Set([...companionIds].map(normalizeCompanionId))];
      const unknownEntries = requestedIds
        .filter(companionId => !namesByCompanionId.has(companionId))
        .map(companionId => ({ companionId }));
      const scopedResolve = unknownEntries.length > 0
        ? createCompanionDisplayIdentityResolver([...normalizedRoster, ...unknownEntries]).resolve
        : resolve;
      const identities: Record<string, CompanionDisplayIdentity> = {};
      for (const companionId of requestedIds) {
        const identity = scopedResolve(companionId);
        identities[identity.companionId] = identity;
      }
      return Object.freeze(identities);
    },
  });
}

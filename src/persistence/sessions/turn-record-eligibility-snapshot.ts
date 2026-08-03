import {
  resolveSessionEntryTurnContext,
  type SessionEntryTurnContext,
} from '../../core/session/turn-provenance.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';

export class TurnRecordEligibilitySnapshotChangedError extends Error {
  constructor() {
    super('TurnRecord eligibility snapshot changed while acquiring consumed-record fences');
    this.name = 'TurnRecordEligibilitySnapshotChangedError';
  }
}

export class TurnRecordEligibilitySnapshotInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnRecordEligibilitySnapshotInvalidError';
  }
}

export type SourceTurnRecordEligibility =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ineligible' }
  | { readonly kind: 'eligible'; readonly record: TurnRecord };

export function sessionEntrySnapshotMatches(
  left: readonly SessionEntry[],
  right: readonly SessionEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const candidate = right[index]!;
    return entry.id === candidate.id
      && entry.channelId === candidate.channelId
      && entry.role === candidate.role
      && entry.content === candidate.content
      && entry.authorId === candidate.authorId
      && entry.authorName === candidate.authorName
      && entry.timestamp === candidate.timestamp
      && entry.discordMessageId === candidate.discordMessageId
      && entry.metadata === candidate.metadata
      && entry.originChannelId === candidate.originChannelId
      && entry.channelVisibility === candidate.channelVisibility;
  });
}

interface ConsumedTurnReference {
  sourceChannelId: string;
  turnId: string;
  turnIdSource: SessionEntryTurnContext['turnIdSource'];
  turnRecordExpectation: SessionEntryTurnContext['turnRecordExpectation'];
}

function consumedTurnReference(entry: SessionEntry): ConsumedTurnReference {
  const turn = resolveSessionEntryTurnContext(entry);
  return {
    sourceChannelId: entry.originChannelId?.trim() || entry.channelId,
    turnId: turn.turnId,
    turnIdSource: turn.turnIdSource,
    turnRecordExpectation: turn.turnRecordExpectation,
  };
}

function referenceKey(reference: Pick<ConsumedTurnReference, 'sourceChannelId' | 'turnId'>): string {
  return `${reference.sourceChannelId}\u0000${reference.turnId}`;
}

/**
 * Exposes only entries whose canonical source remains eligible.
 *
 * Observed context that did not execute locally bypasses TurnRecord lookup and
 * remains available to bounded consumers. A missing record is omittable only
 * when the entry lacks a persisted TurnID and therefore uses deterministic
 * backfill identity. All other entries carrying an explicit TurnID fail closed
 * if their record is absent.
 */
export async function selectEligibleTurnRecordSnapshotEntries(input: {
  entries: readonly SessionEntry[];
  logicalSessionId: string;
  lookupEligibility: (
    sourceChannelId: string,
    logicalSessionId: string,
    turnId: string,
  ) => Promise<SourceTurnRecordEligibility>;
}): Promise<readonly SessionEntry[]> {
  const uniqueConsumed = new Map<string, ConsumedTurnReference>();
  for (const entry of input.entries) {
    const reference = consumedTurnReference(entry);
    const key = referenceKey(reference);
    const existing = uniqueConsumed.get(key);
    if (!existing
      || (existing.turnRecordExpectation === 'not_expected'
        && reference.turnRecordExpectation === 'required')
      || (existing.turnRecordExpectation === reference.turnRecordExpectation
        && existing.turnIdSource === 'backfilled'
        && reference.turnIdSource === 'persisted')) {
      uniqueConsumed.set(key, reference);
    }
  }

  const omittedLegacyReferences = new Set<string>();
  for (const [key, reference] of uniqueConsumed) {
    if (reference.turnIdSource === 'persisted'
      && reference.turnRecordExpectation === 'not_expected') {
      continue;
    }
    const eligibility = await input.lookupEligibility(
      reference.sourceChannelId,
      input.logicalSessionId,
      reference.turnId,
    );
    if (eligibility.kind === 'missing' && reference.turnIdSource === 'backfilled') {
      omittedLegacyReferences.add(key);
      continue;
    }
    if (eligibility.kind !== 'eligible') {
      throw new TurnRecordEligibilitySnapshotInvalidError(
        eligibility.kind === 'missing'
          ? 'Consumed TurnRecord is missing for an explicitly bound TurnID'
          : 'Consumed TurnRecord is duplicated, tombstoned, or belongs to another session',
      );
    }
  }

  return input.entries.filter(entry => (
    !omittedLegacyReferences.has(referenceKey(consumedTurnReference(entry)))
  ));
}

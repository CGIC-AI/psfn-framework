// ── One-time channel-envelope migration planner (E3.2) ──
// Derives channel-owned Context Envelope labels (channels.json
// `contextEnvelope.channels`) for channels enumerated from persisted state
// (contact conversation-channel rows + session journals). Report-first and
// deterministic: AMBIGUOUS channels are REPORTED, never guessed — they
// receive the fail-closed default (invite_only) plus a visible
// `needsReview` flag (Garden warning badge + report line).
//
// Pure planning logic: the maintenance CLI
// (src/app/maintenance/migrate-channel-envelope.ts) wires real stores.
// Contract: docs/context-envelope.md.

import type { TrustPolicyConfig } from '../config/trust-policy-config.js';
import {
  CHANNEL_VISIBILITY_ENVELOPE_MIGRATION,
  type ChannelEnvelopeLabel,
  type ChannelPrivacy,
  type LegacyChannelVisibility,
} from './context-envelope.js';

/** Everything the enumeration phase learned about one channel id. */
export interface ChannelEnvelopeObservation {
  channelId: string;
  /**
   * Persisted channel-visibility stamps for this channel (already decoded via
   * decodeObservedVisibility at ingestion — legacy 'semi_private' spellings
   * never reach the planner; retired 'broadcast' stamps are preserved here so
   * the seed keeps the broadcast flag through the documented split).
   */
  storedVisibilities: LegacyChannelVisibility[];
  /** Adapter-known direct-message topology, when the source records it. */
  isDirectMessage?: boolean;
  /** Enumeration provenance, e.g. 'contact_channel_activity', 'session_journal'. */
  sources: string[];
}

export type ChannelEnvelopeMigrationAction =
  | 'skip_existing_label'
  | 'skip_operator_override'
  | 'seed'
  | 'seed_ambiguous';

export type ChannelEnvelopeMigrationEvidence =
  | 'broadcast_prefix'
  | 'private_prefix'
  | 'stored_visibility'
  | 'direct_message';

export interface ChannelEnvelopeMigrationEntry {
  channelId: string;
  action: ChannelEnvelopeMigrationAction;
  /** Label to write for 'seed' / 'seed_ambiguous' entries. */
  label?: ChannelEnvelopeLabel;
  evidence: ChannelEnvelopeMigrationEvidence[];
  sources: string[];
  reason: string;
}

export interface ChannelEnvelopeMigrationPlan {
  entries: ChannelEnvelopeMigrationEntry[];
  counts: Record<ChannelEnvelopeMigrationAction, number>;
}

interface PrivacyPair {
  privacy: ChannelPrivacy;
  broadcast: boolean;
}

function pairFromVisibility(visibility: LegacyChannelVisibility): PrivacyPair {
  const mapped = CHANNEL_VISIBILITY_ENVELOPE_MIGRATION[visibility];
  return { privacy: mapped.channelPrivacy, broadcast: mapped.broadcast };
}

function pairKey(pair: PrivacyPair): string {
  return `${pair.privacy}${pair.broadcast ? '+broadcast' : ''}`;
}

function labelFromPair(pair: PrivacyPair): ChannelEnvelopeLabel {
  return pair.broadcast
    ? { privacy: 'public', broadcast: true }
    : { privacy: pair.privacy };
}

const AMBIGUOUS_LABEL: ChannelEnvelopeLabel = { privacy: 'invite_only', needsReview: true };

function matchesOperatorOverride(channelId: string, trustPolicy: TrustPolicyConfig): boolean {
  const overrides = trustPolicy.channelClassification.visibilityOverrides;
  if (Object.prototype.hasOwnProperty.call(overrides.exact, channelId)) return true;
  return Object.keys(overrides.prefix).some(prefix => channelId.startsWith(prefix));
}

function deriveEntry(
  observation: ChannelEnvelopeObservation,
  trustPolicy: TrustPolicyConfig,
): Pick<ChannelEnvelopeMigrationEntry, 'action' | 'label' | 'evidence' | 'reason'> {
  const { channelId } = observation;
  const classification = trustPolicy.channelClassification;

  // Prefix heuristics are the documented seed-derivation path: they were the
  // deterministic pre-envelope classification authority for these channels,
  // so their pair seeds the channel record verbatim (behavior unchanged).
  if (classification.broadcastPrefixes.some(prefix => channelId.startsWith(prefix))) {
    return {
      action: 'seed',
      label: labelFromPair(pairFromVisibility('broadcast')),
      evidence: ['broadcast_prefix'],
      reason: 'broadcast prefix heuristic (executed broadcast split: public + broadcast flag)',
    };
  }
  if (classification.privatePrefixes.some(prefix => channelId.startsWith(prefix))) {
    return {
      action: 'seed',
      label: labelFromPair(pairFromVisibility('private')),
      evidence: ['private_prefix'],
      reason: 'private prefix heuristic',
    };
  }

  // Persisted evidence: unanimous stored stamps and/or DM topology.
  const candidates = new Map<string, { pair: PrivacyPair; evidence: ChannelEnvelopeMigrationEvidence }>();
  for (const visibility of observation.storedVisibilities) {
    const pair = pairFromVisibility(visibility);
    candidates.set(pairKey(pair), { pair, evidence: 'stored_visibility' });
  }
  if (observation.isDirectMessage === true) {
    const pair = pairFromVisibility('private');
    candidates.set(pairKey(pair), { pair, evidence: 'direct_message' });
  }

  if (candidates.size === 1) {
    const [candidate] = candidates.values();
    const evidence: ChannelEnvelopeMigrationEvidence[] = [];
    if (observation.storedVisibilities.length > 0) evidence.push('stored_visibility');
    if (observation.isDirectMessage === true) evidence.push('direct_message');
    return {
      action: 'seed',
      label: labelFromPair(candidate.pair),
      evidence,
      reason: `unanimous persisted evidence (${pairKey(candidate.pair)})`,
    };
  }

  if (candidates.size > 1) {
    const spellings = [...candidates.keys()].sort().join(' vs ');
    return {
      action: 'seed_ambiguous',
      label: AMBIGUOUS_LABEL,
      evidence: observation.storedVisibilities.length > 0 ? ['stored_visibility'] : [],
      reason: `conflicting persisted evidence (${spellings}); fail-closed invite_only, operator review required`,
    };
  }

  return {
    action: 'seed_ambiguous',
    label: AMBIGUOUS_LABEL,
    evidence: [],
    reason: 'no derivable evidence; fail-closed invite_only, operator review required',
  };
}

export function planChannelEnvelopeMigration(input: {
  observations: ChannelEnvelopeObservation[];
  trustPolicy: TrustPolicyConfig;
  existingLabels: Record<string, ChannelEnvelopeLabel>;
}): ChannelEnvelopeMigrationPlan {
  const { observations, trustPolicy, existingLabels } = input;

  // Merge duplicate observations per channel id.
  const merged = new Map<string, ChannelEnvelopeObservation>();
  for (const observation of observations) {
    const channelId = observation.channelId.trim();
    if (!channelId) continue;
    const existing = merged.get(channelId);
    if (!existing) {
      merged.set(channelId, {
        channelId,
        storedVisibilities: [...observation.storedVisibilities],
        ...(observation.isDirectMessage !== undefined ? { isDirectMessage: observation.isDirectMessage } : {}),
        sources: [...observation.sources],
      });
      continue;
    }
    existing.storedVisibilities.push(...observation.storedVisibilities);
    if (observation.isDirectMessage !== undefined) {
      existing.isDirectMessage = existing.isDirectMessage === undefined
        ? observation.isDirectMessage
        : existing.isDirectMessage || observation.isDirectMessage;
    }
    for (const source of observation.sources) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    }
  }

  const entries: ChannelEnvelopeMigrationEntry[] = [];
  for (const observation of [...merged.values()].sort((a, b) => a.channelId.localeCompare(b.channelId))) {
    const { channelId, sources } = observation;

    const existingLabel = Object.hasOwn(existingLabels, channelId) ? existingLabels[channelId] : undefined;
    if (existingLabel && (existingLabel.privacy !== undefined || existingLabel.broadcast !== undefined)) {
      entries.push({
        channelId,
        action: 'skip_existing_label',
        evidence: [],
        sources,
        reason: 'channel already carries an owned envelope label',
      });
      continue;
    }

    if (matchesOperatorOverride(channelId, trustPolicy)) {
      entries.push({
        channelId,
        action: 'skip_operator_override',
        evidence: [],
        sources,
        reason: 'operator trust-policy override already owns this channel; not duplicated into channels.json',
      });
      continue;
    }

    const derived = deriveEntry(observation, trustPolicy);
    entries.push({ channelId, sources, ...derived });
  }

  const counts: Record<ChannelEnvelopeMigrationAction, number> = {
    skip_existing_label: 0,
    skip_operator_override: 0,
    seed: 0,
    seed_ambiguous: 0,
  };
  for (const entry of entries) counts[entry.action] += 1;

  return { entries, counts };
}

/**
 * Ingestion helper: decode a persisted channel-visibility stamp (session
 * journals, contact rows) for planner input. Legacy 'semi_private' decodes to
 * 'invite_only'; anything unrecognized is dropped (reported by callers).
 * Unlike the runtime read decoder, the retired 'broadcast' stamp is
 * PRESERVED so the migration seeds the broadcast flag through the documented
 * split (this command is the migration boundary for that vocabulary).
 */
export function decodeObservedVisibility(value: unknown): LegacyChannelVisibility | undefined {
  if (value === 'semi_private') return 'invite_only';
  if (value === 'private' || value === 'invite_only' || value === 'public' || value === 'broadcast') {
    return value;
  }
  return undefined;
}

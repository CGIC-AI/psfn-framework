import { apiGet } from '$lib/api/client';
import type { AdminConfirmationsData } from '$lib/types';

export interface AttentionSource {
  /** Nav item path this count attaches to (must match nav.ts exactly). */
  path: string;
  fetchCount: () => Promise<number>;
}

export type AttentionCounts = Record<string, number>;

export type AttentionScopeKey = string | null;

export function shouldResetAttentionCounts(
  previousScope: AttentionScopeKey | undefined,
  nextScope: AttentionScopeKey,
): boolean {
  return previousScope !== undefined && previousScope !== nextScope;
}

export type AttentionPollResult =
  | { path: string; count: number }
  | { path: string; count?: never };

export function mergeAttentionPollResults(
  current: AttentionCounts,
  results: AttentionPollResult[],
): AttentionCounts {
  const polled = { ...current };
  for (const result of results) {
    if (result.count !== undefined) polled[result.path] = result.count;
  }
  return polled;
}

export function updateAttentionCountsIfChanged(
  current: AttentionCounts,
  polled: AttentionCounts,
  write: (counts: AttentionCounts) => void,
): AttentionCounts {
  const currentPaths = Object.keys(current);
  const polledPaths = Object.keys(polled);
  if (
    currentPaths.length === polledPaths.length
    && polledPaths.every((path) => current[path] === polled[path])
  ) {
    return current;
  }
  write(polled);
  return polled;
}

interface ContactApprovalEntryLite {
  status: 'pending' | 'denied';
}

interface GraphProposalLite {
  status: string;
}

interface IntakeQuarantineListLite {
  items?: Array<{ status: string }>;
}

interface CogSecEventListLite {
  events?: Array<{ type: string; status: string }>;
}

interface JournalStatusLite {
  attentionCount: number;
}

async function confirmationsCount(): Promise<number> {
  const data = await apiGet<AdminConfirmationsData>('/api/admin/confirmations');
  if (!data.available) return 0;
  return data.entries.length;
}

async function contactApprovalsCount(): Promise<number> {
  const data = await apiGet<{ entries: ContactApprovalEntryLite[] }>('/api/admin/contact-approvals');
  return data.entries.filter((entry) => entry.status === 'pending').length;
}

async function cogsecApprovalsCount(): Promise<number> {
  const data = await apiGet<IntakeQuarantineListLite>('/api/admin/intake/quarantine');
  return (data.items ?? []).filter((item) => item.status === 'held').length;
}

async function graphProposalsCount(): Promise<number> {
  const data = await apiGet<{ proposals: GraphProposalLite[] }>('/api/admin/graph-proposals');
  return data.proposals.filter((proposal) => proposal.status === 'pending').length;
}

// Open session-integrity (HMAC-chain) incidents awaiting operator review (bead
// g59z). These are durable CogSec cases of type 'session_integrity' recorded
// when a session's stored history fails verification; they surface on the
// Cognitive Security > Remediation page.
async function sessionIntegrityIncidentsCount(): Promise<number> {
  const data = await apiGet<CogSecEventListLite>('/api/admin/session-routes/cogsec/events');
  return (data.events ?? []).filter(
    (event) => event.type === 'session_integrity' && event.status === 'open',
  ).length;
}

async function journalHealthAttentionCount(): Promise<number> {
  const data = await apiGet<JournalStatusLite>('/api/admin/values/status');
  return data.attentionCount;
}

export const ATTENTION_SOURCES: AttentionSource[] = [
  { path: '/confirmations', fetchCount: confirmationsCount },
  { path: '/contact-approvals', fetchCount: contactApprovalsCount },
  { path: '/cognitive-security/approvals', fetchCount: cogsecApprovalsCount },
  { path: '/cognitive-security/remediation', fetchCount: sessionIntegrityIncidentsCount },
  { path: '/graph-proposals', fetchCount: graphProposalsCount },
  { path: '/values', fetchCount: journalHealthAttentionCount },
];

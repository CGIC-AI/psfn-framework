import { apiGet } from '$lib/api/client';
import type { AdminConfirmationsData } from '$lib/types';

export interface AttentionSource {
  /** Nav item path this count attaches to (must match nav.ts exactly). */
  path: string;
  fetchCount: () => Promise<number>;
}

export type AttentionCounts = Record<string, number>;

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

export const ATTENTION_SOURCES: AttentionSource[] = [
  { path: '/confirmations', fetchCount: confirmationsCount },
  { path: '/contact-approvals', fetchCount: contactApprovalsCount },
  { path: '/cognitive-security/approvals', fetchCount: cogsecApprovalsCount },
  { path: '/graph-proposals', fetchCount: graphProposalsCount },
];

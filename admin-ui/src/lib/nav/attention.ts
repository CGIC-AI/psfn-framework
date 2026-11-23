import { apiGet } from '$lib/api/client';
import {
  isGardenEventBusConnected,
  retainGardenEventBus,
  subscribeGardenEventBusConnection,
  subscribeGardenEvents,
} from '$lib/events/garden-event-bus.svelte';
import type { GardenEventEnvelope, GardenEventFilter } from '$lib/events/envelope';
import {
  createVisibilityAwarePoller,
  type VisibilityAwarePoller,
  type VisibilityDocument,
} from '$lib/polling/visibility-aware-poller';
import type { AdminConfirmationsData, HumanEscalationSnapshot } from '$lib/types';
import type { InboxTabId } from './canonical-routes';

export interface AttentionSource {
  /** Nav item path this count attaches to (must match nav.ts exactly). */
  path: string;
  fetchCount: () => Promise<number>;
}

export interface InboxAttentionSource {
  tab: InboxTabId;
  fetchCount: () => Promise<number>;
}

export type InboxTabCounts = Record<InboxTabId, number>;

export type AttentionCounts = Record<string, number>;

export type AttentionScopeKey = string | null;

export function emptyInboxTabCounts(): InboxTabCounts {
  return {
    confirmations: 0,
    escalations: 0,
    contacts: 0,
    graph: 0,
    cogsec: 0,
    remediation: 0,
  };
}

let currentInboxTabCounts: InboxTabCounts = emptyInboxTabCounts();
const inboxTabListeners = new Set<(counts: InboxTabCounts) => void>();
const inboxChangeListeners = new Set<() => void>();

export function getInboxTabCounts(): InboxTabCounts {
  return { ...currentInboxTabCounts };
}

export function resetInboxTabCounts(): void {
  currentInboxTabCounts = emptyInboxTabCounts();
  const snapshot = getInboxTabCounts();
  for (const listener of inboxTabListeners) listener(snapshot);
}

export function subscribeInboxTabCounts(
  listener: (counts: InboxTabCounts) => void,
): () => void {
  inboxTabListeners.add(listener);
  listener(getInboxTabCounts());
  return () => inboxTabListeners.delete(listener);
}

/** Notify the Garden shell that an operator resolved or mutated an Inbox item. */
export function notifyInboxAttentionChanged(): void {
  for (const listener of inboxChangeListeners) listener();
}

function subscribeInboxAttentionChanges(listener: () => void): () => void {
  inboxChangeListeners.add(listener);
  return () => inboxChangeListeners.delete(listener);
}

function publishInboxTabCounts(next: InboxTabCounts): void {
  const keys = Object.keys(next) as InboxTabId[];
  if (keys.every((key) => currentInboxTabCounts[key] === next[key])) {
    return;
  }
  currentInboxTabCounts = { ...next };
  const snapshot = getInboxTabCounts();
  for (const listener of inboxTabListeners) listener(snapshot);
}

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

async function escalationsCount(): Promise<number> {
  const data = await apiGet<Pick<HumanEscalationSnapshot, 'counts' | 'escalations'>>(
    '/api/admin/escalations?state=open',
  );
  if (typeof data.counts?.open === 'number' && Number.isFinite(data.counts.open)) {
    return Math.max(0, data.counts.open);
  }
  return Array.isArray(data.escalations) ? data.escalations.length : 0;
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
// when a session's stored history fails verification; they surface in Inbox ->
// Integrity Remediation.
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

export const INBOX_ATTENTION_SOURCES: InboxAttentionSource[] = [
  { tab: 'confirmations', fetchCount: confirmationsCount },
  { tab: 'escalations', fetchCount: escalationsCount },
  { tab: 'contacts', fetchCount: contactApprovalsCount },
  { tab: 'graph', fetchCount: graphProposalsCount },
  { tab: 'cogsec', fetchCount: cogsecApprovalsCount },
  { tab: 'remediation', fetchCount: sessionIntegrityIncidentsCount },
];

export async function refreshInboxAttentionBreakdown(
  previous: InboxTabCounts = currentInboxTabCounts,
  sources: readonly InboxAttentionSource[] = INBOX_ATTENTION_SOURCES,
): Promise<{ counts: InboxTabCounts; total: number }> {
  const next: InboxTabCounts = { ...previous };
  await Promise.all(
    sources.map(async (source) => {
      try {
        const count = await source.fetchCount();
        if (Number.isFinite(count) && count >= 0) {
          next[source.tab] = Math.trunc(count);
        }
      } catch {
        // Retain last verified count for this tab on transient error.
      }
    }),
  );
  publishInboxTabCounts(next);
  const total = Object.values(next).reduce((sum, count) => sum + count, 0);
  return { counts: next, total };
}

export const ATTENTION_SOURCES: AttentionSource[] = [
  {
    path: '/inbox',
    fetchCount: async () => (await refreshInboxAttentionBreakdown()).total,
  },
  { path: '/values', fetchCount: journalHealthAttentionCount },
];

export interface AttentionRefreshBus {
  retain(): () => void;
  isConnected(): boolean;
  subscribeEvents(
    listener: (event: GardenEventEnvelope) => void,
    filter?: GardenEventFilter,
  ): () => void;
  subscribeConnection(listener: (connected: boolean) => void): () => void;
}

export interface AttentionRefreshController {
  start(): void;
  stop(): void;
  requestRefresh(): void;
}

const sharedAttentionBus: AttentionRefreshBus = {
  retain: retainGardenEventBus,
  isConnected: isGardenEventBusConnected,
  subscribeEvents: subscribeGardenEvents,
  subscribeConnection: subscribeGardenEventBusConnection,
};

/**
 * Push-driven attention badge controller.
 *
 * Fetches once immediately on start (when authentication is active), refreshes
 * immediately on `garden.queue.changed` WebSocket events or local operator
 * Inbox mutations, and disables periodic polling while the WebSocket is live.
 * Periodic fallback polling only runs when the WebSocket is disconnected.
 */
export function createAttentionRefreshController(options: {
  refresh: () => void | Promise<unknown>;
  fallbackIntervalMs?: number;
  documentRef?: VisibilityDocument;
  bus?: AttentionRefreshBus;
  subscribeLocalChanges?: (listener: () => void) => () => void;
}): AttentionRefreshController {
  const bus = options.bus ?? sharedAttentionBus;
  const subscribeLocalChanges = options.subscribeLocalChanges ?? subscribeInboxAttentionChanges;
  const poller: VisibilityAwarePoller = createVisibilityAwarePoller({
    refresh: options.refresh,
    intervalMs: options.fallbackIntervalMs ?? 60_000,
    pollingEnabled: !bus.isConnected(),
    ...(options.documentRef ? { documentRef: options.documentRef } : {}),
  });

  let running = false;
  let disconnectedWhileRunning = false;
  let releaseBus: (() => void) | undefined;
  let unsubscribeEvents: (() => void) | undefined;
  let unsubscribeConnection: (() => void) | undefined;
  let unsubscribeLocal: (() => void) | undefined;

  function start(): void {
    if (running) return;
    running = true;
    unsubscribeEvents = bus.subscribeEvents(
      () => poller.requestRefresh(),
      { types: ['garden.queue.changed'] },
    );
    unsubscribeConnection = bus.subscribeConnection((connected) => {
      if (!connected) {
        disconnectedWhileRunning = true;
      } else if (disconnectedWhileRunning) {
        disconnectedWhileRunning = false;
        poller.requestRefresh();
      }
      poller.setPollingEnabled(!connected);
    });
    unsubscribeLocal = subscribeLocalChanges(() => poller.requestRefresh());
    releaseBus = bus.retain();
    poller.setPollingEnabled(!bus.isConnected());
    poller.start();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    disconnectedWhileRunning = false;
    unsubscribeEvents?.();
    unsubscribeEvents = undefined;
    unsubscribeConnection?.();
    unsubscribeConnection = undefined;
    unsubscribeLocal?.();
    unsubscribeLocal = undefined;
    poller.stop();
    releaseBus?.();
    releaseBus = undefined;
  }

  return {
    start,
    stop,
    requestRefresh: () => poller.requestRefresh(),
  };
}

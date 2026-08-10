// Cognitive Security intake endpoints (htm9.11): firewall policy view,
// source-list flywheel CRUD, and the quarantine approval queue with its
// server-side double-confirm flow.

import { apiGet } from '$lib/api/client';
import { apiPostProtected } from '$lib/api/protected-mutation';
import {
  createQueuePageCache,
  isIntakeQuarantineListData,
  normalizeIntakeQuarantineListData,
} from '$lib/cache/queue-cache';
import type { LocalFirstDataSource, LocalFirstResult } from '$lib/cache/local-first';
import type {
  AdminIntakeQuarantineFirewallStatus,
  AdminIntakeQuarantineItemDetail,
  AdminIntakeQuarantineItemView,
  AdminIntakeQuarantineSourceListAction,
  AdminIntakeSourceListMutationInput,
  IntakePolicyConfig,
  IntakeSourceListsConfig,
} from '$lib/types';
import type {
  IntakeQuarantineDecisionAction as CanonicalIntakeQuarantineDecisionAction,
} from '../../../../../src/core/cogsec/intake/quarantine-store.js';

export type IntakeQuarantineDecisionAction = CanonicalIntakeQuarantineDecisionAction;

export interface IntakePolicyOverviewData {
  policy: IntakePolicyConfig;
}

export interface IntakeSourceListsData {
  lists: IntakeSourceListsConfig;
}

export interface IntakeSourceListMutationResult {
  ok: boolean;
  message?: string;
  lists?: IntakeSourceListsConfig;
}

export interface IntakeQuarantineListData {
  items: AdminIntakeQuarantineItemView[];
  /**
   * Cluster-owned shared firewall status (waw5q). Present whenever the
   * runtime serves the enriched projection; lets the UI state that an empty
   * queue never means the firewall is off.
   */
  firewallStatus?: AdminIntakeQuarantineFirewallStatus;
}

export interface IntakeQuarantineItemData {
  item: AdminIntakeQuarantineItemDetail;
}

export interface IntakeQuarantineConfirmResult {
  ok: boolean;
  confirmToken: string;
  expiresAtMs: number;
  summary: string;
}

export interface IntakeQuarantineDecideResult {
  ok: boolean;
  item: AdminIntakeQuarantineItemView;
  message: string;
}

const intakeQuarantineCache = createQueuePageCache({
  key: 'intake-quarantine',
  path: '/api/admin/intake/quarantine',
  validate: isIntakeQuarantineListData,
  normalize: normalizeIntakeQuarantineListData,
});

/** Read-only intake-policy view (mode, tiers, thresholds, quarantine limits). */
export function getIntakePolicy(): Promise<IntakePolicyOverviewData> {
  return apiGet<IntakePolicyOverviewData>('/api/admin/intake/policy');
}

/** Trusted/denied sites and people (the flywheel's persisted state). */
export function getIntakeSourceLists(): Promise<IntakeSourceListsData> {
  return apiGet<IntakeSourceListsData>('/api/admin/intake/source-lists');
}

export function mutateIntakeSourceList(
  input: AdminIntakeSourceListMutationInput,
  reason: string,
): Promise<IntakeSourceListMutationResult> {
  return apiPostProtected<IntakeSourceListMutationResult>(
    '/api/admin/intake/source-lists', input, reason,
  );
}

export function loadIntakeQuarantineLocalFirst(
  onData: (data: IntakeQuarantineListData, source: LocalFirstDataSource) => void,
): Promise<LocalFirstResult<IntakeQuarantineListData>> {
  return intakeQuarantineCache.load(onData);
}

export function getIntakeQuarantineItem(id: string): Promise<IntakeQuarantineItemData> {
  return apiGet<IntakeQuarantineItemData>(
    `/api/admin/intake/quarantine/${encodeURIComponent(id)}`,
  );
}

/**
 * Step 1 of the server-side double-confirm: returns a single-use, short-TTL
 * confirm token bound to this item + decision. Endpoint:
 * POST /api/admin/intake/quarantine/:id/confirm
 */
function intakeQuarantineConfirmPath(id: string): string {
  return `/api/admin/intake/quarantine/${encodeURIComponent(id)}/confirm`;
}

function intakeQuarantineDecidePath(id: string): string {
  return `/api/admin/intake/quarantine/${encodeURIComponent(id)}/decide`;
}

export function confirmIntakeQuarantineDecision(
  id: string,
  input: {
    action: IntakeQuarantineDecisionAction;
    sourceList?: AdminIntakeQuarantineSourceListAction;
  },
  reason = '',
): Promise<IntakeQuarantineConfirmResult> {
  return apiPostProtected<IntakeQuarantineConfirmResult>(
    intakeQuarantineConfirmPath(id), input, reason,
  );
}

/**
 * Step 2: executes the decision with the confirm token. Endpoint:
 * POST /api/admin/intake/quarantine/:id/decide
 */
export function decideIntakeQuarantine(
  id: string,
  input: {
    action: IntakeQuarantineDecisionAction;
    sourceList?: AdminIntakeQuarantineSourceListAction;
    confirmToken: string;
    reason: string;
  },
): Promise<IntakeQuarantineDecideResult> {
  return apiPostProtected<IntakeQuarantineDecideResult>(
    intakeQuarantineDecidePath(id), input, input.reason,
  );
}

// Cognitive Security intake endpoints (htm9.11): firewall policy view,
// source-list flywheel CRUD, and the quarantine approval queue with its
// server-side double-confirm flow.

import { apiGet, apiPost } from '$lib/api/client';
import type {
  AdminIntakeQuarantineItemDetail,
  AdminIntakeQuarantineItemView,
  AdminIntakeQuarantineSourceListAction,
  AdminIntakeSourceListMutationInput,
  IntakePolicyConfig,
  IntakeSourceListsConfig,
} from '$lib/types';

export type IntakeQuarantineDecisionAction = 'release_raw' | 'release_sanitized' | 'discard';

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
): Promise<IntakeSourceListMutationResult> {
  return apiPost<IntakeSourceListMutationResult>('/api/admin/intake/source-lists', input);
}

/** The quarantine approval queue (held items first, newest first). */
export function getIntakeQuarantine(): Promise<IntakeQuarantineListData> {
  return apiGet<IntakeQuarantineListData>('/api/admin/intake/quarantine');
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
export function confirmIntakeQuarantineDecision(
  id: string,
  input: {
    action: IntakeQuarantineDecisionAction;
    sourceList?: AdminIntakeQuarantineSourceListAction;
  },
): Promise<IntakeQuarantineConfirmResult> {
  return apiPost<IntakeQuarantineConfirmResult>(
    `/api/admin/intake/quarantine/${encodeURIComponent(id)}/confirm`,
    input,
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
  return apiPost<IntakeQuarantineDecideResult>(
    `/api/admin/intake/quarantine/${encodeURIComponent(id)}/decide`,
    input,
  );
}

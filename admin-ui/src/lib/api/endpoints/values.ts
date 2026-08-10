import { apiGet, apiPost } from '$lib/api/client';
import { apiPostProtected } from '$lib/api/protected-mutation';
import { isRecord } from '../../../../../src/shared/utils/types.js';
import type { PrivacyBreakGlassReasonCategory } from '../../../../../src/shared/contracts/privacy-break-glass.js';
import type {
  AdminReflectionDailyData,
  AdminReflectionJournalData,
  AdminReflectionMetacognitionData,
  AdminValuesData,
  ReflectionDailyJournalEntry,
  ReflectionJournalEntry,
  ReflectionMetacognitionJournalEntry,
  ValuesJournalEntry,
} from '$lib/types';

export type JournalPrivacyStream =
  | 'values-journal'
  | 'reflection-metacognition'
  | 'reflection-daily'
  | 'reflection-journal';

export interface JournalPrivacyBreakGlassInput {
  stream: JournalPrivacyStream;
  reasonCategory: PrivacyBreakGlassReasonCategory;
  reason: string;
}

export interface JournalPrivacyBreakGlassConfirmation extends JournalPrivacyBreakGlassInput {
  confirmToken: string;
  expiresAt: string;
  expiresAtMs: number;
}

export type JournalPrivacyDisclosure =
  | { stream: 'values-journal'; entries: ValuesJournalEntry[] }
  | { stream: 'reflection-metacognition'; entries: ReflectionMetacognitionJournalEntry[] }
  | { stream: 'reflection-daily'; entries: ReflectionDailyJournalEntry[] }
  | { stream: 'reflection-journal'; entries: ReflectionJournalEntry[] };

const CONFIRM_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const PRIVACY_REASON_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const PRIVACY_REASON_MAX_LENGTH = 384;

function checkedPrivacyReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized
    || normalized.length > PRIVACY_REASON_MAX_LENGTH
    || PRIVACY_REASON_CONTROL_CHARS.test(normalized)) {
    throw new Error(
      `A privacy break-glass reason of 1-${PRIVACY_REASON_MAX_LENGTH} printable characters is required`,
    );
  }
  return normalized;
}

function journalPrivacyConfirmPath(stream: JournalPrivacyStream): string {
  return `/api/admin/privacy-break-glass/journal/${encodeURIComponent(stream)}/confirm`;
}

function journalPrivacyDecisionPath(stream: JournalPrivacyStream): string {
  return `/api/admin/privacy-break-glass/journal/${encodeURIComponent(stream)}/decide`;
}

export async function beginJournalPrivacyBreakGlass(
  input: JournalPrivacyBreakGlassInput,
): Promise<JournalPrivacyBreakGlassConfirmation> {
  const reason = checkedPrivacyReason(input.reason);
  const response: unknown = await apiPostProtected(journalPrivacyConfirmPath(input.stream), {
      reasonCategory: input.reasonCategory,
      reason,
    }, reason);
  if (!isRecord(response)
    || response.ok !== true
    || typeof response.confirmToken !== 'string'
    || !CONFIRM_TOKEN_PATTERN.test(response.confirmToken)
    || typeof response.expiresAt !== 'string') {
    throw new Error('Privacy break-glass confirmation response is malformed');
  }
  const expiresAtMs = Date.parse(response.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error('Privacy break-glass confirmation response is malformed');
  }
  return {
    stream: input.stream,
    reasonCategory: input.reasonCategory,
    reason,
    confirmToken: response.confirmToken,
    expiresAt: response.expiresAt,
    expiresAtMs,
  };
}

export async function decideJournalPrivacyBreakGlass(
  confirmation: JournalPrivacyBreakGlassConfirmation,
): Promise<JournalPrivacyDisclosure> {
  if (Date.now() >= confirmation.expiresAtMs) {
    throw new Error('Privacy break-glass confirmation expired; request a new confirmation');
  }
  const response: unknown = await apiPost(
    journalPrivacyDecisionPath(confirmation.stream),
    {
      reasonCategory: confirmation.reasonCategory,
      reason: confirmation.reason,
      confirmToken: confirmation.confirmToken,
    },
  );
  if (!isRecord(response)
    || response.ok !== true
    || !isRecord(response.disclosure)
    || response.disclosure.kind !== 'journal'
    || !isRecord(response.disclosure.journal)
    || response.disclosure.journal.stream !== confirmation.stream
    || !Array.isArray(response.disclosure.journal.entries)) {
    throw new Error('Privacy break-glass decision response is malformed');
  }
  const entries = response.disclosure.journal.entries;
  switch (confirmation.stream) {
    case 'values-journal':
      return { stream: confirmation.stream, entries: entries as ValuesJournalEntry[] };
    case 'reflection-metacognition':
      return { stream: confirmation.stream, entries: entries as ReflectionMetacognitionJournalEntry[] };
    case 'reflection-daily':
      return { stream: confirmation.stream, entries: entries as ReflectionDailyJournalEntry[] };
    default:
      return { stream: confirmation.stream, entries: entries as ReflectionJournalEntry[] };
  }
}

/**
 * Fetch values journal entries from the admin API.
 * Endpoint: GET /api/admin/values
 *
 * Note: This endpoint must be added to the backend api-routes.ts.
 * Until then, the page will show a "no data" state.
 */
export function getValuesData(): Promise<AdminValuesData> {
  return apiGet<AdminValuesData>('/api/admin/values');
}

export function getReflectionMetacognitionData(): Promise<AdminReflectionMetacognitionData> {
  return apiGet<AdminReflectionMetacognitionData>('/api/admin/values/reflections/metacognition');
}

export function getReflectionDailyData(): Promise<AdminReflectionDailyData> {
  return apiGet<AdminReflectionDailyData>('/api/admin/values/reflections/daily');
}

export function getReflectionJournalData(): Promise<AdminReflectionJournalData> {
  return apiGet<AdminReflectionJournalData>('/api/admin/values/reflections/journal');
}

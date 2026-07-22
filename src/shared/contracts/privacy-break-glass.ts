import { createHash } from 'node:crypto';
import { assertNoUnknownKeys, isRecord } from '../utils/types.js';

export const PRIVACY_BREAK_GLASS_REASON_CATEGORIES = [
  'incident_response',
  'safety_intervention',
  'data_repair',
  'legal_emergency',
] as const;

export type PrivacyBreakGlassReasonCategory =
  typeof PRIVACY_BREAK_GLASS_REASON_CATEGORIES[number];
export type PrivacyBreakGlassResourceKind = 'memory' | 'profile' | 'journal';

export interface PrivacyBreakGlassConfirmRequest {
  reasonCategory: PrivacyBreakGlassReasonCategory;
  reason: string;
}

export interface PrivacyBreakGlassDecideRequest extends PrivacyBreakGlassConfirmRequest {
  confirmToken: string;
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const CONFIRM_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

function reasonCategory(value: unknown): PrivacyBreakGlassReasonCategory {
  if (typeof value !== 'string'
    || !(PRIVACY_BREAK_GLASS_REASON_CATEGORIES as readonly string[]).includes(value)) {
    throw new Error('Privacy break-glass reasonCategory is invalid');
  }
  return value as PrivacyBreakGlassReasonCategory;
}

function reason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Privacy break-glass reason must be a string');
  const normalized = value.trim();
  if (!normalized || normalized.length > 384 || CONTROL_PATTERN.test(normalized)) {
    throw new Error('Privacy break-glass reason is invalid');
  }
  return normalized;
}

export function parsePrivacyBreakGlassConfirmRequest(
  value: unknown,
): PrivacyBreakGlassConfirmRequest {
  if (!isRecord(value)) throw new Error('Privacy break-glass confirmation must be an object');
  assertNoUnknownKeys(value, ['reasonCategory', 'reason'], 'privacyBreakGlassConfirm');
  return {
    reasonCategory: reasonCategory(value.reasonCategory),
    reason: reason(value.reason),
  };
}

export function parsePrivacyBreakGlassDecideRequest(
  value: unknown,
): PrivacyBreakGlassDecideRequest {
  if (!isRecord(value)) throw new Error('Privacy break-glass decision must be an object');
  assertNoUnknownKeys(
    value,
    ['reasonCategory', 'reason', 'confirmToken'],
    'privacyBreakGlassDecide',
  );
  if (typeof value.confirmToken !== 'string' || !CONFIRM_TOKEN_PATTERN.test(value.confirmToken)) {
    throw new Error('Privacy break-glass confirmToken is invalid');
  }
  return {
    reasonCategory: reasonCategory(value.reasonCategory),
    reason: reason(value.reason),
    confirmToken: value.confirmToken,
  };
}

export function privacyBreakGlassPurpose(
  request: PrivacyBreakGlassConfirmRequest,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    reasonCategory: request.reasonCategory,
    reason: request.reason,
  });
}

export function privacyBreakGlassReasonDigest(
  request: PrivacyBreakGlassConfirmRequest,
): string {
  return createHash('sha256').update(privacyBreakGlassPurpose(request), 'utf8').digest('hex');
}

export function privacyBreakGlassResourceSelectorDigest(
  resourceKind: PrivacyBreakGlassResourceKind,
  resourceId: string,
): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    resourceKind,
    resourceId,
  }), 'utf8').digest('hex');
}

export function privacyBreakGlassSubjectScopeDigest(input: {
  companionId: string;
  action: string;
  routeId: string;
  resourceKind: PrivacyBreakGlassResourceKind;
  resourceId: string;
}): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    companionId: input.companionId,
    action: input.action,
    routeId: input.routeId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
  }), 'utf8').digest('hex');
}

export function privacyBreakGlassResourceKindForRoute(
  routeId: string,
): PrivacyBreakGlassResourceKind | null {
  if (routeId === 'POST /api/admin/privacy-break-glass/memory/:id/confirm'
    || routeId === 'POST /api/admin/privacy-break-glass/memory/:id/decide') {
    return 'memory';
  }
  if (routeId === 'POST /api/admin/privacy-break-glass/profile/:id/confirm'
    || routeId === 'POST /api/admin/privacy-break-glass/profile/:id/decide') {
    return 'profile';
  }
  return null;
}

export function isPrivacyBreakGlassConfirmRoute(routeId: string): boolean {
  return privacyBreakGlassResourceKindForRoute(routeId) !== null && routeId.endsWith('/confirm');
}

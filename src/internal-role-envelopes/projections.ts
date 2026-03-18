import {
  isInternalRoleEnvelopeKind,
  isInternalRoleEnvelopeSourceStage,
  isInternalRolePromotionTarget,
  type InternalRoleEnvelopeKind,
  type InternalRoleEnvelopeSourceStage,
  type InternalRolePromotionTarget,
} from './types.js';

export const SESSION_ROLE_ENVELOPE_PREVIEW_SCHEMA_VERSION = 1 as const;

export interface SessionRoleEnvelopePreview {
  schemaVersion: 1;
  envelopeId: string;
  internalRole: InternalRoleEnvelopeKind;
  summary: string;
  sourceStage: InternalRoleEnvelopeSourceStage;
  promotionTarget: InternalRolePromotionTarget;
  promotedRef?: string;
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Session role envelope preview ${field} must be non-empty`);
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeRoleEnvelopeRefs(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeSessionRoleEnvelopePreview(
  input: SessionRoleEnvelopePreview,
): SessionRoleEnvelopePreview {
  if (!isInternalRoleEnvelopeKind(input.internalRole)) {
    throw new Error(`Unknown session role envelope preview internalRole "${String(input.internalRole)}"`);
  }
  if (!isInternalRoleEnvelopeSourceStage(input.sourceStage)) {
    throw new Error(`Unknown session role envelope preview sourceStage "${String(input.sourceStage)}"`);
  }
  if (!isInternalRolePromotionTarget(input.promotionTarget)) {
    throw new Error(`Unknown session role envelope preview promotionTarget "${String(input.promotionTarget)}"`);
  }

  return {
    schemaVersion: SESSION_ROLE_ENVELOPE_PREVIEW_SCHEMA_VERSION,
    envelopeId: normalizeRequiredString(input.envelopeId, 'envelopeId'),
    internalRole: input.internalRole,
    summary: normalizeRequiredString(input.summary, 'summary'),
    sourceStage: input.sourceStage,
    promotionTarget: input.promotionTarget,
    ...(normalizeOptionalString(input.promotedRef)
      ? { promotedRef: normalizeOptionalString(input.promotedRef) }
      : {}),
  };
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Session role envelope preview field "${fieldName}" must be a string`);
  }
  return normalizeOptionalString(value);
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Session role envelope preview field "${fieldName}" must be a string`);
  }
  return normalizeRequiredString(value, fieldName);
}

export function parseSessionRoleEnvelopePreview(
  value: unknown,
  fieldName = 'roleEnvelopePreview',
): SessionRoleEnvelopePreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Session role envelope preview field "${fieldName}" must be an object`);
  }

  const preview = value as Record<string, unknown>;
  const schemaVersion = preview.schemaVersion;
  if (
    typeof schemaVersion !== 'number'
    || !Number.isFinite(schemaVersion)
    || Math.floor(schemaVersion) !== SESSION_ROLE_ENVELOPE_PREVIEW_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported session role envelope preview schemaVersion "${String(schemaVersion)}"`);
  }

  const internalRole = parseRequiredString(preview.internalRole, `${fieldName}.internalRole`);
  const sourceStage = parseRequiredString(preview.sourceStage, `${fieldName}.sourceStage`);
  const promotionTarget = parseRequiredString(preview.promotionTarget, `${fieldName}.promotionTarget`);
  if (!isInternalRoleEnvelopeKind(internalRole)) {
    throw new Error(`Session role envelope preview field "${fieldName}.internalRole" is invalid`);
  }
  if (!isInternalRoleEnvelopeSourceStage(sourceStage)) {
    throw new Error(`Session role envelope preview field "${fieldName}.sourceStage" is invalid`);
  }
  if (!isInternalRolePromotionTarget(promotionTarget)) {
    throw new Error(`Session role envelope preview field "${fieldName}.promotionTarget" is invalid`);
  }

  return {
    schemaVersion: SESSION_ROLE_ENVELOPE_PREVIEW_SCHEMA_VERSION,
    envelopeId: parseRequiredString(preview.envelopeId, `${fieldName}.envelopeId`),
    internalRole,
    summary: parseRequiredString(preview.summary, `${fieldName}.summary`),
    sourceStage,
    promotionTarget,
    ...(parseOptionalString(preview.promotedRef, `${fieldName}.promotedRef`)
      ? { promotedRef: parseOptionalString(preview.promotedRef, `${fieldName}.promotedRef`) }
      : {}),
  };
}

export function resolveRoleEnvelopeRef(preview: SessionRoleEnvelopePreview): string {
  return preview.promotedRef?.trim() || `envelope:${preview.envelopeId}`;
}

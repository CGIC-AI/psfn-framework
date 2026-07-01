export const COGSEC_TOMBSTONE_METADATA_KIND = 'cogsec_l0_tombstone' as const;

const CASE_ID_PATTERN = /^cogsec_[A-Za-z0-9_-]+$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const TOMBSTONE_PATTERN = /^\[CogSec redaction: (cogsec_[A-Za-z0-9_-]+)\]$/u;

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

export function normalizeCogSecCaseId(caseId: string): string {
  const normalized = normalizeRequiredString(caseId, 'caseId');
  if (!CASE_ID_PATTERN.test(normalized)) {
    throw new Error('caseId must match cogsec_[A-Za-z0-9_-]+');
  }
  return normalized;
}

export function buildCogSecTombstoneContent(caseId: string): string {
  return `[CogSec redaction: ${normalizeCogSecCaseId(caseId)}]`;
}

export function isCogSecTombstoneContent(content: string): boolean {
  return TOMBSTONE_PATTERN.test(content.trim());
}

export function parseCogSecTombstoneCaseId(input: {
  content: string;
  metadata?: string;
}): string | null {
  if (typeof input.metadata === 'string' && input.metadata.trim().length > 0) {
    try {
      const parsed = JSON.parse(input.metadata) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const row = parsed as Record<string, unknown>;
        if (
          row.kind === COGSEC_TOMBSTONE_METADATA_KIND
          && typeof row.caseId === 'string'
          && CASE_ID_PATTERN.test(row.caseId)
        ) {
          return row.caseId;
        }
      }
    } catch {
      // Fall back to the public tombstone string.
    }
  }

  const match = TOMBSTONE_PATTERN.exec(input.content.trim());
  return match ? match[1] : null;
}

export function isCogSecTombstoneSessionEntry(input: {
  content: string;
  metadata?: string;
}): boolean {
  return parseCogSecTombstoneCaseId(input) !== null;
}

export function buildCogSecTombstoneMetadata(input: {
  caseId: string;
  redactedAt: string;
  actor?: string;
}): string {
  const caseId = normalizeCogSecCaseId(input.caseId);
  const redactedAt = normalizeRequiredString(input.redactedAt, 'redactedAt');
  if (!ISO_INSTANT_PATTERN.test(redactedAt) || Number.isNaN(Date.parse(redactedAt))) {
    throw new Error('redactedAt must be an ISO instant');
  }

  const actor = input.actor?.trim();
  return JSON.stringify({
    kind: COGSEC_TOMBSTONE_METADATA_KIND,
    caseId,
    redactedAt,
    ...(actor ? { actor } : {}),
  });
}

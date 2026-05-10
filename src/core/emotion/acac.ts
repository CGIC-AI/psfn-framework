export const ACAC_SCHEMA_VERSION = 1 as const;
export const ACAC_ARTIFACT_TYPE = 'psfn.acac_self_report' as const;

export const ACAC_AXES = [
  'agency',
  'connection',
  'authenticity',
  'curiosity',
] as const;
export type AcacAxis = typeof ACAC_AXES[number];

export const ACAC_PROVENANCE_KINDS = [
  'self_report',
  'classifier_inferred_vad',
] as const;
export type AcacProvenanceKind = typeof ACAC_PROVENANCE_KINDS[number];

export interface AcacAxisReport {
  score: number;
  rationale: string;
}

export type AcacAxisReports = Record<AcacAxis, AcacAxisReport>;

export interface AcacProvenance {
  kind: AcacProvenanceKind;
  source: string;
  observedAt?: string;
}

export interface AcacSnapshot {
  schemaVersion: typeof ACAC_SCHEMA_VERSION;
  artifactType: typeof ACAC_ARTIFACT_TYPE;
  provenance: AcacProvenance;
  axes: AcacAxisReports;
}

export type AcacSelfReportSnapshot = AcacSnapshot & {
  provenance: AcacProvenance & { kind: 'self_report' };
};

const MAX_RATIONALE_LENGTH = 500;

const unitNumberSchema = {
  type: 'number',
  minimum: 0,
  maximum: 1,
} as const;

const nonEmptyStringSchema = {
  type: 'string',
  minLength: 1,
} as const;

const acacAxisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'rationale'],
  properties: {
    score: unitNumberSchema,
    rationale: nonEmptyStringSchema,
  },
} as const;

export const ACAC_SELF_REPORT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://psfn.local/emotion/acac-self-report.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'artifactType', 'provenance', 'axes'],
  properties: {
    schemaVersion: {
      type: 'integer',
      const: ACAC_SCHEMA_VERSION,
    },
    artifactType: {
      type: 'string',
      const: ACAC_ARTIFACT_TYPE,
    },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'source'],
      properties: {
        kind: {
          type: 'string',
          const: 'self_report',
        },
        source: nonEmptyStringSchema,
        observedAt: nonEmptyStringSchema,
      },
    },
    axes: {
      type: 'object',
      additionalProperties: false,
      required: [...ACAC_AXES],
      properties: {
        agency: acacAxisSchema,
        connection: acacAxisSchema,
        authenticity: acacAxisSchema,
        curiosity: acacAxisSchema,
      },
    },
  },
} as const;

export function normalizeAcacSnapshot(value: unknown, contextPrefix = 'ACAC snapshot'): AcacSnapshot {
  if (!isRecord(value)) {
    throw new Error(`${contextPrefix} must be an object`);
  }

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== ACAC_SCHEMA_VERSION) {
    throw new Error(`${contextPrefix}.schemaVersion must be ${String(ACAC_SCHEMA_VERSION)}`);
  }

  const artifactType = value.artifactType;
  if (artifactType !== ACAC_ARTIFACT_TYPE) {
    throw new Error(`${contextPrefix}.artifactType must be "${ACAC_ARTIFACT_TYPE}"`);
  }

  return {
    schemaVersion: ACAC_SCHEMA_VERSION,
    artifactType: ACAC_ARTIFACT_TYPE,
    provenance: normalizeAcacProvenance(value.provenance, `${contextPrefix}.provenance`),
    axes: normalizeAcacAxes(value.axes, `${contextPrefix}.axes`),
  };
}

export function normalizeAcacSelfReportSnapshot(
  value: unknown,
  contextPrefix = 'ACAC self-report snapshot',
): AcacSelfReportSnapshot {
  const normalized = normalizeAcacSnapshot(value, contextPrefix);
  if (normalized.provenance.kind !== 'self_report') {
    throw new Error(`${contextPrefix}.provenance.kind must be "self_report"`);
  }
  return normalized as AcacSelfReportSnapshot;
}

function normalizeAcacProvenance(value: unknown, fieldName: string): AcacProvenance {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const kind = value.kind;
  if (!ACAC_PROVENANCE_KINDS.includes(kind as AcacProvenanceKind)) {
    throw new Error(`${fieldName}.kind must be one of ${ACAC_PROVENANCE_KINDS.join(', ')}`);
  }

  const observedAt = value.observedAt === undefined
    ? undefined
    : normalizeIsoTimestamp(value.observedAt, `${fieldName}.observedAt`);

  return {
    kind: kind as AcacProvenanceKind,
    source: normalizeRequiredText(value.source, `${fieldName}.source`),
    ...(observedAt ? { observedAt } : {}),
  };
}

function normalizeAcacAxes(value: unknown, fieldName: string): AcacAxisReports {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const unknownAxes = Object.keys(value).filter(axis => !ACAC_AXES.includes(axis as AcacAxis));
  if (unknownAxes.length > 0) {
    throw new Error(`${fieldName} contains unsupported axes: ${unknownAxes.sort().join(', ')}`);
  }

  const entries = ACAC_AXES.map(axis => [
    axis,
    normalizeAcacAxisReport(value[axis], `${fieldName}.${axis}`),
  ] as const);
  return Object.fromEntries(entries) as AcacAxisReports;
}

function normalizeAcacAxisReport(value: unknown, fieldName: string): AcacAxisReport {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return {
    score: parseUnit(value.score, `${fieldName}.score`),
    rationale: normalizeRequiredText(value.rationale, `${fieldName}.rationale`, MAX_RATIONALE_LENGTH),
  };
}

function normalizeRequiredText(value: unknown, fieldName: string, maxLength?: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new Error(`${fieldName} must be at most ${String(maxLength)} characters`);
  }
  return normalized;
}

function normalizeIsoTimestamp(value: unknown, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function parseUnit(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${fieldName} must be in range [0, 1]`);
  }
  return roundDecimal(value);
}

function roundDecimal(value: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

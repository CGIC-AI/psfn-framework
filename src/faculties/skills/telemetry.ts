import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord } from '../../shared/utils/types.js';
import type {
  SkillInvocationOutcome,
  SkillInvocationRecordInput,
  SkillUsageStats,
} from './types.js';

export const SKILL_USAGE_TELEMETRY_FILE_NAME = 'skill-usage-stats.json';

const TELEMETRY_VERSION = 1;
const MAX_SKILL_USAGE_NAME_CHARS = 256;

interface StoredSkillUsageRecord {
  name: string;
  firstUsedAt: string;
  lastUsedAt: string;
  invocationCount: number;
  successCount: number;
  failureCount: number;
  durationSampleCount: number;
  totalDurationMs: number;
  lastDurationMs: number | null;
  lastOutcome: SkillInvocationOutcome;
}

interface StoredSkillUsageTelemetry {
  version: typeof TELEMETRY_VERSION;
  skills: Record<string, StoredSkillUsageRecord | undefined>;
}

interface SkillUsageTelemetryStoreOptions {
  now?: () => Date;
  filePath?: string;
}

function normalizeSkillUsageName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error('Skill usage telemetry requires a non-empty skill name');
  }
  if (normalized.length > MAX_SKILL_USAGE_NAME_CHARS) {
    throw new Error(`Skill usage telemetry name exceeds ${MAX_SKILL_USAGE_NAME_CHARS} characters`);
  }
  return normalized;
}

function normalizeSkillUsageKey(name: string): string {
  return normalizeSkillUsageName(name).toLowerCase();
}

function normalizeOccurredAt(value: Date | string | undefined, fallback: Date): string {
  const candidate = value ?? fallback;
  const parsed = candidate instanceof Date
    ? candidate.getTime()
    : Date.parse(candidate);
  if (Number.isNaN(parsed)) {
    throw new Error('Skill usage telemetry occurredAt must be a valid ISO-8601 timestamp');
  }
  return new Date(parsed).toISOString();
}

function normalizeOutcome(value: unknown): SkillInvocationOutcome {
  if (value === 'success' || value === 'failure') return value;
  throw new Error('Skill usage telemetry outcome must be success or failure');
}

function normalizeDurationMs(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Skill usage telemetry durationMs must be a non-negative finite number');
  }
  return value;
}

function readNonNegativeInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid skill usage telemetry: ${field} must be a non-negative integer`);
  }
  return value as number;
}

function readNonNegativeNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid skill usage telemetry: ${field} must be a non-negative finite number`);
  }
  return value;
}

function readIsoTimestamp(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid skill usage telemetry: ${field} must be a timestamp string`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid skill usage telemetry: ${field} must be ISO-8601`);
  }
  return new Date(parsed).toISOString();
}

function readOptionalDuration(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid skill usage telemetry: ${field} must be null or a non-negative finite number`);
  }
  return value;
}

function parseStoredRecord(key: string, value: unknown): StoredSkillUsageRecord {
  if (!isRecord(value)) {
    throw new Error(`Invalid skill usage telemetry: record ${key} must be an object`);
  }

  const name = normalizeSkillUsageName(typeof value.name === 'string' ? value.name : '');
  const normalizedKey = normalizeSkillUsageKey(name);
  if (normalizedKey !== key) {
    throw new Error(`Invalid skill usage telemetry: key mismatch for ${name}`);
  }

  const invocationCount = readNonNegativeInteger(value, 'invocationCount');
  const successCount = readNonNegativeInteger(value, 'successCount');
  const failureCount = readNonNegativeInteger(value, 'failureCount');
  if (invocationCount !== successCount + failureCount) {
    throw new Error(`Invalid skill usage telemetry: counts do not add up for ${name}`);
  }
  if (invocationCount < 1) {
    throw new Error(`Invalid skill usage telemetry: invocationCount must be positive for ${name}`);
  }

  const durationSampleCount = readNonNegativeInteger(value, 'durationSampleCount');
  if (durationSampleCount > invocationCount) {
    throw new Error(`Invalid skill usage telemetry: too many duration samples for ${name}`);
  }

  return {
    name,
    firstUsedAt: readIsoTimestamp(value, 'firstUsedAt'),
    lastUsedAt: readIsoTimestamp(value, 'lastUsedAt'),
    invocationCount,
    successCount,
    failureCount,
    durationSampleCount,
    totalDurationMs: readNonNegativeNumber(value, 'totalDurationMs'),
    lastDurationMs: readOptionalDuration(value, 'lastDurationMs'),
    lastOutcome: normalizeOutcome(value.lastOutcome),
  };
}

function emptyTelemetry(): StoredSkillUsageTelemetry {
  return {
    version: TELEMETRY_VERSION,
    skills: {},
  };
}

function toPublicStats(record: StoredSkillUsageRecord): SkillUsageStats {
  return {
    name: record.name,
    firstUsedAt: record.firstUsedAt,
    lastUsedAt: record.lastUsedAt,
    invocationCount: record.invocationCount,
    successCount: record.successCount,
    failureCount: record.failureCount,
    durationSampleCount: record.durationSampleCount,
    averageDurationMs: record.durationSampleCount > 0
      ? record.totalDurationMs / record.durationSampleCount
      : null,
    lastDurationMs: record.lastDurationMs,
    lastOutcome: record.lastOutcome,
    successRate: record.invocationCount > 0
      ? record.successCount / record.invocationCount
      : null,
  };
}

export class SkillUsageTelemetryStore {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(dataDir: string, options: SkillUsageTelemetryStoreOptions = {}) {
    this.filePath = options.filePath ?? join(dataDir, SKILL_USAGE_TELEMETRY_FILE_NAME);
    this.now = options.now ?? (() => new Date());
  }

  record(name: string, input: SkillInvocationRecordInput): SkillUsageStats {
    const displayName = normalizeSkillUsageName(name);
    const key = normalizeSkillUsageKey(displayName);
    const outcome = normalizeOutcome(input.outcome);
    const occurredAt = normalizeOccurredAt(input.occurredAt, this.now());
    const durationMs = normalizeDurationMs(input.durationMs);
    const telemetry = this.load();
    const existing = telemetry.skills[key];
    const nextInvocationCount = (existing?.invocationCount ?? 0) + 1;
    const nextSuccessCount = (existing?.successCount ?? 0) + (outcome === 'success' ? 1 : 0);
    const nextFailureCount = (existing?.failureCount ?? 0) + (outcome === 'failure' ? 1 : 0);
    const nextDurationSampleCount = (existing?.durationSampleCount ?? 0) + (durationMs === null ? 0 : 1);
    const nextTotalDurationMs = (existing?.totalDurationMs ?? 0) + (durationMs ?? 0);

    const record: StoredSkillUsageRecord = {
      name: existing?.name ?? displayName,
      firstUsedAt: existing?.firstUsedAt ?? occurredAt,
      lastUsedAt: occurredAt,
      invocationCount: nextInvocationCount,
      successCount: nextSuccessCount,
      failureCount: nextFailureCount,
      durationSampleCount: nextDurationSampleCount,
      totalDurationMs: nextTotalDurationMs,
      lastDurationMs: durationMs,
      lastOutcome: outcome,
    };

    telemetry.skills[key] = record;
    this.save(telemetry);
    return toPublicStats(record);
  }

  get(name: string): SkillUsageStats | null {
    const key = normalizeSkillUsageKey(name);
    const record = this.load().skills[key];
    return record ? toPublicStats(record) : null;
  }

  list(): SkillUsageStats[] {
    return Object.values(this.load().skills)
      .filter((record): record is StoredSkillUsageRecord => record !== undefined)
      .map(record => toPublicStats(record))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private load(): StoredSkillUsageTelemetry {
    if (!existsSync(this.filePath)) {
      return emptyTelemetry();
    }

    const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== TELEMETRY_VERSION || !isRecord(parsed.skills)) {
      throw new Error('Invalid skill usage telemetry file');
    }

    const telemetry = emptyTelemetry();
    for (const [key, value] of Object.entries(parsed.skills)) {
      telemetry.skills[key] = parseStoredRecord(key, value);
    }
    return telemetry;
  }

  private save(telemetry: StoredSkillUsageTelemetry): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(telemetry, null, 2);
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, `${payload}\n`, 'utf-8');
    renameSync(tempPath, this.filePath);
  }
}

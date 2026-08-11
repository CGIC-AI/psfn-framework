import {
  captureDurableFileSnapshot,
  type DurableFileSnapshot,
} from './filesystem-snapshot.js';

interface PostgresWriteCounters {
  readonly deleted: string;
  readonly inserted: string;
  readonly rowCount?: string;
  readonly rowFingerprint?: string;
  readonly updated: string;
}

export type PostgresWriteSnapshot = Readonly<Record<string, PostgresWriteCounters>>;

interface IdlePurityFilesystemAllowance {
  readonly path: string;
  readonly reason: string;
}

interface IdlePurityAllowlist {
  readonly filesystem?: readonly IdlePurityFilesystemAllowance[];
}

export interface IdlePurityCertificationInput {
  readonly allowlist?: IdlePurityAllowlist;
  readonly capturePostgresWrites: () => Promise<PostgresWriteSnapshot>;
  readonly idleWindowMs: number;
  readonly runtimeRoot: string;
  readonly stabilization?: IdlePurityStabilization;
  readonly wait?: (durationMs: number) => Promise<void>;
}

interface IdlePurityStabilization {
  readonly sampleIntervalMs: number;
  readonly timeoutMs: number;
}

export interface IdlePurityCertificationReport {
  readonly allowedChanges: readonly string[];
  readonly violations: readonly string[];
}

class IdlePurityViolationError extends Error {
  constructor(readonly report: IdlePurityCertificationReport) {
    super(`Idle-purity certification failed:\n${report.violations.join('\n')}`);
    this.name = 'IdlePurityViolationError';
  }
}

interface IdlePurityChange {
  readonly description: string;
  readonly surface: 'filesystem' | 'postgres';
  readonly target: string;
}

function compareFiles(
  before: DurableFileSnapshot,
  after: DurableFileSnapshot,
): IdlePurityChange[] {
  const changes: IdlePurityChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const previous = before.get(path);
    const current = after.get(path);
    let description: string | undefined;
    if (!previous) description = `filesystem created: ${path}`;
    else if (!current) description = `filesystem deleted: ${path}`;
    else if (previous.kind !== current.kind || previous.fingerprint !== current.fingerprint) {
      description = `filesystem modified: ${path}`;
    }
    if (description) changes.push({ description, surface: 'filesystem', target: path });
  }
  return changes;
}

function parseCounter(value: string, relation: string, field: string): bigint {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`Invalid PostgreSQL ${field} counter for ${relation}: ${value}`);
  }
  return BigInt(value);
}

function comparePostgres(
  before: PostgresWriteSnapshot,
  after: PostgresWriteSnapshot,
): IdlePurityChange[] {
  const changes: IdlePurityChange[] = [];
  const relations = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const relation of [...relations].sort()) {
    const previous = before[relation];
    const current = after[relation];
    if (!current) {
      changes.push({
        description: `postgres relation disappeared: ${relation}`,
        surface: 'postgres',
        target: relation,
      });
      continue;
    }
    const previousRowCount = previous?.rowCount;
    const previousRowFingerprint = previous?.rowFingerprint;
    const currentRowCount = current.rowCount;
    const currentRowFingerprint = current.rowFingerprint;
    const previousHasState = previousRowCount !== undefined
      && previousRowFingerprint !== undefined;
    const currentHasState = currentRowCount !== undefined
      && currentRowFingerprint !== undefined;
    if (previousHasState !== currentHasState) {
      throw new Error(`Inconsistent PostgreSQL physical-state snapshot for ${relation}`);
    }
    if (!previous && currentHasState) {
      changes.push({
        description: `postgres relation appeared: ${relation}`,
        surface: 'postgres',
        target: relation,
      });
      continue;
    }
    if (previousRowCount !== undefined && previousRowFingerprint !== undefined
      && currentRowCount !== undefined && currentRowFingerprint !== undefined) {
      parseCounter(previousRowCount, relation, 'rowCount');
      parseCounter(currentRowCount, relation, 'rowCount');
      if (!previousRowFingerprint || !currentRowFingerprint) {
        throw new Error(`Invalid PostgreSQL row fingerprint for ${relation}`);
      }
    }
    const physicalStateChanged = previousHasState && currentHasState
      && (previousRowCount !== currentRowCount
        || previousRowFingerprint !== currentRowFingerprint);
    const delta = (field: 'deleted' | 'inserted' | 'updated'): bigint => {
      const beforeValue = previous ? parseCounter(previous[field], relation, field) : 0n;
      const afterValue = parseCounter(current[field], relation, field);
      return afterValue - beforeValue;
    };
    const inserted = delta('inserted');
    const updated = delta('updated');
    const deleted = delta('deleted');
    const deltas = [inserted, updated, deleted] as const;
    if (deltas.some(delta => delta < 0n)) {
      changes.push({
        description: `postgres counters reset: ${relation}`,
        surface: 'postgres',
        target: relation,
      });
      continue;
    }
    if (deltas.every(delta => delta === 0n)) {
      if (physicalStateChanged) {
        changes.push({
          description: `postgres state changed: ${relation}`,
          surface: 'postgres',
          target: relation,
        });
      }
      continue;
    }
    changes.push({
      description: `postgres wrote: ${relation} (inserted=${inserted.toString()}, `
        + `updated=${updated.toString()}, deleted=${deleted.toString()})`,
      surface: 'postgres',
      target: relation,
    });
  }
  return changes;
}

function validateAllowlist(allowlist: IdlePurityAllowlist): void {
  for (const allowance of allowlist.filesystem ?? []) {
    if (!allowance.path || allowance.path.startsWith('/')
      || allowance.path.split('/').includes('..')) {
      throw new Error(`Invalid idle-purity filesystem allowance: ${allowance.path}`);
    }
    if (!allowance.reason.trim()) throw new Error('Idle-purity allowances require a reason');
  }
}

function allowanceReason(
  change: IdlePurityChange,
  allowlist: IdlePurityAllowlist,
): string | undefined {
  if (change.surface !== 'filesystem') return undefined;
  return allowlist.filesystem?.find(allowance => change.target === allowance.path)?.reason;
}

function classifyChanges(
  changes: readonly IdlePurityChange[],
  allowlist: IdlePurityAllowlist,
): IdlePurityCertificationReport {
  const allowedChanges: string[] = [];
  const violations: string[] = [];
  for (const change of changes) {
    const reason = allowanceReason(change, allowlist);
    if (reason) allowedChanges.push(`${change.description} (${reason})`);
    else violations.push(change.description);
  }
  return { allowedChanges, violations };
}

interface IdlePuritySnapshot {
  readonly files: DurableFileSnapshot;
  readonly postgres: PostgresWriteSnapshot;
}

async function captureSnapshot(input: IdlePurityCertificationInput): Promise<IdlePuritySnapshot> {
  return {
    files: await captureDurableFileSnapshot(input.runtimeRoot),
    postgres: await input.capturePostgresWrites(),
  };
}

function compareSnapshots(
  before: IdlePuritySnapshot,
  after: IdlePuritySnapshot,
): IdlePurityChange[] {
  return [
    ...compareFiles(before.files, after.files),
    ...comparePostgres(before.postgres, after.postgres),
  ];
}

async function waitForDuration(durationMs: number): Promise<void> {
  await new Promise<void>(resolveWait => setTimeout(resolveWait, durationMs));
}

function validateDuration(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
}

async function captureStableBaseline(
  input: IdlePurityCertificationInput,
  allowlist: IdlePurityAllowlist,
  wait: (durationMs: number) => Promise<void>,
): Promise<IdlePuritySnapshot> {
  const stabilization = input.stabilization;
  let candidate = await captureSnapshot(input);
  if (!stabilization) return candidate;
  validateDuration(stabilization.sampleIntervalMs, 'Idle-purity sample interval', false);
  validateDuration(stabilization.timeoutMs, 'Idle-purity stabilization timeout', false);
  if (stabilization.timeoutMs < stabilization.sampleIntervalMs) {
    throw new Error('Idle-purity stabilization timeout must cover at least one sample interval');
  }
  const maximumSamples = Math.ceil(
    stabilization.timeoutMs / stabilization.sampleIntervalMs,
  );
  let lastReport: IdlePurityCertificationReport = { allowedChanges: [], violations: [] };
  for (let sample = 0; sample < maximumSamples; sample += 1) {
    await wait(stabilization.sampleIntervalMs);
    const current = await captureSnapshot(input);
    lastReport = classifyChanges(compareSnapshots(candidate, current), allowlist);
    candidate = current;
    if (lastReport.violations.length === 0) return candidate;
  }
  throw new Error(
    `Idle-purity baseline did not stabilize:\n${lastReport.violations.join('\n')}`,
  );
}

export async function certifyIdlePurity(
  input: IdlePurityCertificationInput,
): Promise<IdlePurityCertificationReport> {
  validateDuration(input.idleWindowMs, 'Idle-purity window', true);
  const allowlist = input.allowlist ?? {};
  validateAllowlist(allowlist);
  const wait = input.wait ?? waitForDuration;
  const before = await captureStableBaseline(input, allowlist, wait);
  await wait(input.idleWindowMs);
  const after = await captureSnapshot(input);
  const report = classifyChanges(compareSnapshots(before, after), allowlist);
  if (report.violations.length > 0) throw new IdlePurityViolationError(report);
  return report;
}

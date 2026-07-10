import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeDiagnosticsSnapshot,
  recordBackupDiagnosticOutcome,
  recordToolValidationFailure,
  resetRuntimeDiagnosticsForTests,
} from './runtime-diagnostics.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
  recordDiagnosticLogRecordForTests,
} from '../logger.js';

describe('runtime diagnostics', () => {
  let tempDir: string | undefined;

  beforeEach(() => {
    resetRuntimeDiagnosticsForTests();
    clearDiagnosticLogRingBufferForTests();
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    resetRuntimeDiagnosticsForTests();
    clearDiagnosticLogRingBufferForTests();
  });

  it('keeps the logger warning/error ring bounded', () => {
    for (let index = 0; index < 300; index += 1) {
      recordDiagnosticLogRecordForTests({
        level: 'warn',
        message: `warning ${index}`,
        component: 'BoundsTest',
        observedAt: 1_700_000_000_000 + index,
      });
    }

    const records = getRecentDiagnosticLogRecords({ limit: 300 });

    expect(records).toHaveLength(256);
    expect(records.some(record => record.message === 'warning 0')).toBe(false);
    expect(records[0]).toMatchObject({ message: 'warning 299', component: 'BoundsTest' });
  });

  it('redacts secrets, bearer tokens, API keys, database passwords, and private content patterns', () => {
    recordDiagnosticLogRecordForTests({
      level: 'error',
      component: 'RedactionTest',
      observedAt: 1_700_000_000_000,
      message: 'Bearer abc.def.ghi api_key=super-secret signed_url_secret=abc123 postgres://user:db-pass@localhost/db prompt: "private conversation about health"',
    });

    const payload = buildRuntimeDiagnosticsSnapshot({
      now: () => 1_700_000_000_100,
      windowMs: 1000,
      includeFileLogs: false,
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('[REDACTED_SECRET]');
    expect(serialized).toContain('[REDACTED_CONTENT]');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('db-pass');
    expect(serialized).not.toContain('private conversation');
  });

  it('counts validation failures by tool inside the requested bounded window', () => {
    recordToolValidationFailure({
      toolName: 'toolset',
      observedAt: 1_700_000_000_000,
      reason: 'Validation failed for tool "toolset"',
    });
    recordToolValidationFailure({
      toolName: 'toolset',
      observedAt: 1_700_000_000_500,
      reason: 'Validation failed for tool "toolset"',
    });
    recordToolValidationFailure({
      toolName: 'memory',
      observedAt: 1_699_999_000_000,
      reason: 'Validation failed for tool "memory"',
    });

    const payload = buildRuntimeDiagnosticsSnapshot({
      now: () => 1_700_000_001_000,
      windowMs: 2_000,
      includeFileLogs: false,
    });

    expect(payload.toolValidationFailures.total).toBe(2);
    expect(payload.toolValidationFailures.byTool).toEqual([{
      toolName: 'toolset',
      count: 2,
      firstSeenAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_000_500,
    }]);
  });

  it('returns explicit unavailable markers for kube-only rollout and pod data', () => {
    const payload = buildRuntimeDiagnosticsSnapshot({
      now: () => 1_700_000_000_000,
      includeFileLogs: false,
    });

    expect(payload.rollout).toEqual({
      status: 'unavailable',
      reason: 'requires kube surface (x5rt.4)',
    });
    expect(payload.pods).toEqual({
      status: 'unavailable',
      reason: 'requires kube surface (x5rt.4)',
    });
    expect(payload.sources).toContainEqual({
      name: 'kubernetes',
      status: 'unavailable',
      reason: 'requires kube surface (x5rt.4)',
    });
  });

  it('reports backup success and failure without exposing full backup paths', () => {
    recordBackupDiagnosticOutcome({
      status: 'success',
      observedAt: 1_700_000_000_000,
      taskId: 'scheduled-backup',
      taskName: 'Session + database backup',
      message: 'Scheduled backup completed',
      backupDir: '/very/private/runtime/backups/20260706T100000',
      details: { copiedSessionFiles: 3, postgresDumpCaptured: true },
    });
    recordBackupDiagnosticOutcome({
      status: 'failure',
      observedAt: 1_700_000_001_000,
      taskId: 'scheduled-backup',
      taskName: 'Session + database backup',
      message: 'password=backup-secret failed',
    });

    const payload = buildRuntimeDiagnosticsSnapshot({
      now: () => 1_700_000_002_000,
      windowMs: 5_000,
      includeFileLogs: false,
    });
    const serialized = JSON.stringify(payload.backup);

    expect(payload.backup.counts).toEqual({ success: 1, failure: 1, total: 2 });
    expect(payload.backup.lastSuccess?.backupId).toBe('20260706T100000');
    expect(serialized).not.toContain('/very/private/runtime');
    expect(serialized).not.toContain('backup-secret');
    expect(serialized).toContain('[REDACTED_SECRET]');
  });

  it('reads bounded file log warning/error lines when the log directory exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-diagnostics-'));
    const logPath = join(tempDir, 'runtime.log');
    writeFileSync(
      logPath,
      [
        'INFO ordinary startup line',
        '12:00:00 WARN [FileComponent] token=secret-token content: "private line"',
        JSON.stringify({
          level: 'error',
          component: 'JsonComponent',
          message: 'api_key=from-json failed',
          timestamp: new Date(1_700_000_000_000).toISOString(),
        }),
      ].join('\n'),
      'utf8',
    );
    const logTime = new Date(1_700_000_000_000);
    utimesSync(logPath, logTime, logTime);

    const payload = buildRuntimeDiagnosticsSnapshot({
      now: () => 1_700_000_001_000,
      windowMs: 10_000,
      logsDir: tempDir,
    });
    const serialized = JSON.stringify(payload.fileLogs);

    expect(payload.fileLogs.status).toBe('available');
    if (payload.fileLogs.status === 'available') {
      expect(payload.fileLogs.counts.total).toBe(2);
      expect(payload.fileLogs.records.map(record => record.component)).toEqual(
        expect.arrayContaining(['FileComponent', 'JsonComponent']),
      );
    }
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('private line');
    expect(serialized).not.toContain('from-json');
  });
});

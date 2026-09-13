import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationalLogStore, readOperationalLogHistory } from './operational-log-store.js';
import { buildRuntimeDiagnosticsSnapshot } from './runtime-diagnostics.js';
import { logger, configureOperationalLogPersistence, closeOperationalLogPersistence, getOperationalLogDirectory } from '../logger.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-13T12:28:00.000Z');
const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'psfn-operational-history-'));
  roots.push(value);
  return value;
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('durable operational metadata', () => {
  it('wires the runtime logger, preserves request metadata, and excludes disabled levels and raw payloads', () => {
    const previousLevel = logger.level;
    logger.level = 'info';
    const logsDir = root();
    configureOperationalLogPersistence({ logsDir, process: 'gateway', retentionDays: 30 });
    try {
      logger.info('LLM request completed', { providerResponseId: 'gen-example', servingProvider: 'Example Provider', totalTokens: 100, body: 'private reply', requestId: 'request-example' });
      logger.debug('Debug event is disabled');
      const history = readOperationalLogHistory(getOperationalLogDirectory()!, { sinceMs: 0, untilMs: Date.now(), limit: 10 });
      expect(history.records).toHaveLength(1);
      expect(history.records[0]?.context).toEqual({ providerResponseId: 'gen-example', servingProvider: 'Example Provider', totalTokens: 100, requestId: 'request-example' });
      expect(JSON.stringify(history)).not.toContain('private reply');
      const diagnostics = buildRuntimeDiagnosticsSnapshot({ logsDir, includeFileLogs: true });
      expect(diagnostics.fileLogs).toMatchObject({ status: 'available', directory: getOperationalLogDirectory(), records: history.records });
    } finally {
      closeOperationalLogPersistence();
      logger.level = previousLevel;
    }
  });

  it('survives close/reopen, keeps stable IDs and timestamps, and records info/provider metadata', () => {
    const logsDir = root();
    const options = { logsDir, process: 'agent' as const, companionId: 'companion-a', retentionDays: 30, now: () => NOW };
    const first = new OperationalLogStore(options);
    first.record({ observedAt: NOW, level: 'info', message: 'LLM request completed', source: 'in_process', context: { providerResponseId: 'gen-example', servingProvider: 'Example Provider' } });
    first.close();
    const before = readOperationalLogHistory(first.directory, { sinceMs: NOW - DAY, untilMs: NOW, limit: 10 });
    const second = new OperationalLogStore(options);
    expect(readOperationalLogHistory(second.directory, { sinceMs: NOW - DAY, untilMs: NOW, limit: 10 }).records).toEqual(before.records);
    expect(before.records[0]).toMatchObject({ eventId: expect.any(String), observedAt: NOW, level: 'info', context: { servingProvider: 'Example Provider', providerResponseId: 'gen-example' } });
    expect(readdirSync(first.directory)).toHaveLength(2);
    second.close();
  });

  it('retains young overflow across rotation and deletes only fully expired days', () => {
    let now = NOW;
    const store = new OperationalLogStore({ logsDir: root(), process: 'gateway', retentionDays: 30, now: () => now });
    for (let index = 0; index < 300; index += 1) store.record({ observedAt: NOW + index, level: 'error', message: 'Background action failed', source: 'in_process' });
    now += 30 * DAY;
    store.record({ observedAt: now, level: 'info', message: 'Rotation', source: 'in_process' });
    expect(readOperationalLogHistory(store.directory, { sinceMs: NOW, untilMs: now, limit: 1000 }).records).toHaveLength(301);
    now += 2 * DAY;
    store.record({ observedAt: now, level: 'info', message: 'Rotation', source: 'in_process' });
    const remaining = readOperationalLogHistory(store.directory, { sinceMs: NOW, untilMs: now, limit: 1000 });
    expect(remaining.records).toHaveLength(2);
    store.close();
  });

  it('isolates companions and redacts secrets and content at persistence', () => {
    const logsDir = root();
    const a = new OperationalLogStore({ logsDir, process: 'agent', companionId: 'companion-a', retentionDays: 30, now: () => NOW });
    const b = new OperationalLogStore({ logsDir, process: 'agent', companionId: 'companion-b', retentionDays: 30, now: () => NOW });
    a.record({ observedAt: NOW, level: 'error', message: 'Request failed authorization=private-credential prompt=private words', source: 'in_process', context: { body: 'private body', apiKey: 'private key', provider: 'openrouter' } });
    a.close(); b.close();
    const body = readdirSync(a.directory).map(file => readFileSync(join(a.directory, file), 'utf8')).join('');
    expect(body).not.toMatch(/private-credential|private words|private body|private key/);
    expect(body).toContain('openrouter');
    expect(readOperationalLogHistory(b.directory, { sinceMs: 0, untilMs: NOW, limit: 10 }).records).toEqual([]);
  });

  it('reads historical records beyond the current tail without loading an entire day', () => {
    const store = new OperationalLogStore({ logsDir: root(), process: 'operator', retentionDays: 30, now: () => NOW });
    for (let index = 0; index < 1000; index += 1) store.record({ observedAt: NOW + index, level: 'info', message: `Lifecycle observation ${index}`, source: 'in_process' });
    store.close();
    const history = readOperationalLogHistory(store.directory, { sinceMs: NOW, untilMs: NOW + 2, limit: 3 });
    expect(history.records.map(record => record.observedAt)).toEqual([NOW + 2, NOW + 1, NOW]);
  });

  it('rejects a short retention horizon, missing agent identity, and storage failures explicitly', () => {
    const logsDir = root();
    expect(() => new OperationalLogStore({ logsDir, process: 'gateway', retentionDays: 29 })).toThrow(/at least 30/);
    expect(() => new OperationalLogStore({ logsDir, process: 'agent', retentionDays: 30 })).toThrow(/companion identity/);
    writeFileSync(join(logsDir, 'system'), 'not a directory');
    expect(() => new OperationalLogStore({ logsDir, process: 'gateway', retentionDays: 30 })).toThrow();
  });
});

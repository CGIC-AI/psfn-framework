import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AuditStore } from './audit.js';

describe('AuditStore', () => {
  let db: Database.Database;
  let store: AuditStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new AuditStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('logs an audit entry and returns its id', () => {
    const id = store.log('llm.chat', 'ALLOW', { model: 'test' });
    expect(id).toBeGreaterThan(0);
  });

  it('retrieves recent entries', () => {
    store.log('llm.chat', 'ALLOW');
    store.log('fs.read', 'NEEDS_APPROVAL', { path: '/etc/passwd' });
    store.log('discord.send', 'ALLOW');

    const entries = store.getRecent(10);
    expect(entries).toHaveLength(3);
    // Most recent first
    expect(entries[0].method).toBe('discord.send');
    expect(entries[2].method).toBe('llm.chat');
  });

  it('completes an entry with duration and error', () => {
    const id = store.log('web.fetch', 'ALLOW', { url: 'https://example.com' });
    store.complete(id, 150);

    const entries = store.getRecent(1);
    expect(entries[0].durationMs).toBe(150);
    expect(entries[0].error).toBeNull();
  });

  it('records errors on completion', () => {
    const id = store.log('fs.write', 'NEEDS_APPROVAL');
    store.complete(id, 50, 'Approval denied');

    const entries = store.getRecent(1);
    expect(entries[0].error).toBe('Approval denied');
  });

  it('filters by method', () => {
    store.log('llm.chat', 'ALLOW');
    store.log('fs.read', 'NEEDS_APPROVAL');
    store.log('llm.chat', 'ALLOW');

    const llmEntries = store.getByMethod('llm.chat');
    expect(llmEntries).toHaveLength(2);
    expect(llmEntries.every(e => e.method === 'llm.chat')).toBe(true);
  });

  it('filters approval events (non-ALLOW)', () => {
    store.log('llm.chat', 'ALLOW');
    store.log('fs.read', 'NEEDS_APPROVAL');
    store.log('fs.write', 'DENY');
    store.log('discord.send', 'ALLOW');

    const events = store.getApprovalEvents();
    expect(events).toHaveLength(2);
    expect(events.map(e => e.decision)).toEqual(['DENY', 'NEEDS_APPROVAL']);
  });

  it('counts entries', () => {
    expect(store.count()).toBe(0);
    store.log('llm.chat', 'ALLOW');
    store.log('llm.embed', 'ALLOW');
    expect(store.count()).toBe(2);
  });

  it('summarizes large params', () => {
    store.log('llm.chat', 'ALLOW', {
      systemPrompt: 'x'.repeat(500),
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      content: 'y'.repeat(300),
    });

    const entries = store.getRecent(1);
    const params = entries[0].paramsJson;
    expect(params).toContain('500 chars');
    expect(params).toContain('2 messages');
    expect(params).toContain('300 chars');
  });

  it('preserves correlation fields in stored audit summaries', () => {
    store.log('llm.complete', 'ALLOW', {
      turnId: 'turn-77',
      requestId: 'req-77',
      channelId: 'internal:heartbeat',
      callType: 'scheduled',
      toolName: 'heartbeat_run_template',
      purpose: 'deliberation.aggregator',
    });

    const entries = store.getRecent(1);
    const parsed = JSON.parse(entries[0].paramsJson ?? '{}') as Record<string, string>;
    expect(parsed.turnId).toBe('turn-77');
    expect(parsed.requestId).toBe('req-77');
    expect(parsed.channelId).toBe('internal:heartbeat');
    expect(parsed.callType).toBe('scheduled');
    expect(parsed.toolName).toBe('heartbeat_run_template');
    expect(parsed.purpose).toBe('deliberation.aggregator');
  });

  it('prunes oldest rows when maxCount is exceeded', () => {
    store = new AuditStore(db, {
      maxCount: 2,
      maxAgeMs: 60_000,
      maxSizeBytes: 10_000,
    });

    store.log('first', 'ALLOW');
    store.log('second', 'ALLOW');
    store.log('third', 'ALLOW');

    expect(store.count()).toBe(2);
    expect(store.getRecent(10).map(entry => entry.method)).toEqual(['third', 'second']);
  });

  it('prunes rows older than maxAgeMs', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      store = new AuditStore(db, {
        maxCount: 100,
        maxAgeMs: 1_000,
        maxSizeBytes: 10_000,
      });

      nowSpy.mockReturnValueOnce(1_000);
      store.log('old', 'ALLOW');

      nowSpy.mockReturnValueOnce(3_000);
      store.log('fresh', 'ALLOW');

      expect(store.count()).toBe(1);
      expect(store.getRecent(10)[0].method).toBe('fresh');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('prunes oldest rows when approximate payload size exceeds maxSizeBytes', () => {
    store = new AuditStore(db, {
      maxCount: 100,
      maxAgeMs: 60_000,
      maxSizeBytes: 220,
    });

    store.log('first', 'ALLOW', { note: 'a'.repeat(140) });
    store.log('second', 'ALLOW', { note: 'b'.repeat(140) });

    expect(store.count()).toBe(1);
    expect(store.getRecent(10)[0].method).toBe('second');
  });

  it('rejects invalid rotation configuration', () => {
    expect(() => new AuditStore(db, { maxCount: 0 })).toThrow('maxCount');
    expect(() => new AuditStore(db, { maxAgeMs: 0 })).toThrow('maxAgeMs');
    expect(() => new AuditStore(db, { maxSizeBytes: 0 })).toThrow('maxSizeBytes');
  });

  it('records summary entries with immediate completion', () => {
    store.recordSummary({
      method: 'wyoming.session.start',
      decision: 'ALLOW',
      params: { connectionId: 'conn-1', sessionId: 's-1' },
      durationMs: 12.8,
    });

    const entries = store.getRecent(1);
    expect(entries[0].method).toBe('wyoming.session.start');
    expect(entries[0].durationMs).toBe(12);
    expect(entries[0].error).toBeNull();
  });

  it('creates summary hooks for Wyoming/audit telemetry wiring', () => {
    const hook = store.createSummaryHook();
    hook({
      method: 'wyoming.policy.violation',
      decision: 'DENY',
      params: { code: 'RATE_LIMIT_EXCEEDED' },
      error: 'Session exceeded event rate',
    });

    const entries = store.getRecent(1);
    expect(entries[0].method).toBe('wyoming.policy.violation');
    expect(entries[0].decision).toBe('DENY');
    expect(entries[0].error).toContain('event rate');
  });
});

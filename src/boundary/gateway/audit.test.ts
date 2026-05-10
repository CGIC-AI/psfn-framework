import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AuditStore } from './audit.js';
import type { PolicyDecision } from './protocol.js';

describe('AuditStore', () => {
  let db: Database.Database;
  let store: AuditStore;

  function append(
    method: string,
    decision: PolicyDecision,
    params?: Record<string, unknown>,
  ): Promise<number> {
    return store.append({ method, decision, params });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    store = new AuditStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('logs an audit entry and returns its id', async () => {
    const id = await append('llm.chat', 'ALLOW', { model: 'test' });
    expect(id).toBeGreaterThan(0);
  });

  it('retrieves recent entries', async () => {
    await append('llm.chat', 'ALLOW');
    await append('fs.read', 'NEEDS_APPROVAL', { path: '/etc/passwd' });
    await append('discord.send', 'ALLOW');

    const entries = await store.getRecent(10);
    expect(entries).toHaveLength(3);
    // Most recent first
    expect(entries[0].method).toBe('discord.send');
    expect(entries[2].method).toBe('llm.chat');
  });

  it('completes an entry with duration and error', async () => {
    const id = await append('web.fetch', 'ALLOW', { url: 'https://example.com' });
    await store.complete(id, 150);

    const entries = await store.getRecent(1);
    expect(entries[0].durationMs).toBe(150);
    expect(entries[0].error).toBeNull();
  });

  it('records errors on completion', async () => {
    const id = await append('fs.write', 'NEEDS_APPROVAL');
    await store.complete(id, 50, 'Approval denied');

    const entries = await store.getRecent(1);
    expect(entries[0].error).toBe('Approval denied');
  });

  it('filters by method', async () => {
    await append('llm.chat', 'ALLOW');
    await append('fs.read', 'NEEDS_APPROVAL');
    await append('llm.chat', 'ALLOW');

    const llmEntries = await store.getByMethod('llm.chat');
    expect(llmEntries).toHaveLength(2);
    expect(llmEntries.every(e => e.method === 'llm.chat')).toBe(true);
  });

  it('filters approval events (non-ALLOW)', async () => {
    await append('llm.chat', 'ALLOW');
    await append('fs.read', 'NEEDS_APPROVAL');
    await append('fs.write', 'DENY');
    await append('discord.send', 'ALLOW');

    const events = await store.getApprovalEvents();
    expect(events).toHaveLength(2);
    expect(events.map(e => e.decision)).toEqual(['DENY', 'NEEDS_APPROVAL']);
  });

  it('counts entries', async () => {
    expect(await store.count()).toBe(0);
    await append('llm.chat', 'ALLOW');
    await append('llm.embed', 'ALLOW');
    expect(await store.count()).toBe(2);
  });

  it('summarizes large params', async () => {
    await append('llm.chat', 'ALLOW', {
      systemPrompt: 'x'.repeat(500),
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      content: 'y'.repeat(300),
    });

    const entries = await store.getRecent(1);
    const params = entries[0].paramsJson;
    expect(params).toContain('500 chars');
    expect(params).toContain('2 messages');
    expect(params).toContain('300 chars');
  });

  it('summarizes shard sync envelope and decision fields in audit params', async () => {
    await append('shard.sync.policy', 'DENY', {
      syncEnvelope: {
        version: 1,
        syncClass: 'derived_memory',
        direction: 'shard_to_prime',
        authority: 'shard',
        operation: 'memory_redact',
        shardId: 'shard-sync-1',
        sourceId: 'shard:shard-sync-1',
        targetId: 'memory:index',
        idempotencyKey: 'k'.repeat(140),
        requestedAt: 1_706_000_000_000,
        rawPayload: 'should-not-be-stored',
      },
      syncDecision: {
        allowed: false,
        reason: 'denied_operation',
        extra: 'ignored',
      },
    });

    const entries = await store.getRecent(1);
    const params = JSON.parse(entries[0].paramsJson) as Record<string, Record<string, unknown>>;
    expect(params.syncEnvelope).toMatchObject({
      version: 1,
      syncClass: 'derived_memory',
      direction: 'shard_to_prime',
      authority: 'shard',
      operation: 'memory_redact',
      shardId: 'shard-sync-1',
      sourceId: 'shard:shard-sync-1',
      targetId: 'memory:index',
      requestedAt: 1_706_000_000_000,
    });
    expect(params.syncEnvelope.idempotencyKey).toMatch(/\.\.\. \(140 chars\)$/);
    expect(params.syncEnvelope.rawPayload).toBeUndefined();
    expect(params.syncDecision).toEqual({
      allowed: false,
      reason: 'denied_operation',
    });
  });

  it('preserves correlation fields in stored audit summaries', async () => {
    await append('llm.complete', 'ALLOW', {
      turnId: 'turn-77',
      requestId: 'req-77',
      channelId: 'internal:heartbeat',
      callType: 'scheduled',
      toolName: 'heartbeat_run_template',
      purpose: 'deliberation.aggregator',
    });

    const entries = await store.getRecent(1);
    const parsed = JSON.parse(entries[0].paramsJson) as Record<string, string>;
    expect(parsed.turnId).toBe('turn-77');
    expect(parsed.requestId).toBe('req-77');
    expect(parsed.channelId).toBe('internal:heartbeat');
    expect(parsed.callType).toBe('scheduled');
    expect(parsed.toolName).toBe('heartbeat_run_template');
    expect(parsed.purpose).toBe('deliberation.aggregator');
  });

  it('prunes oldest rows when maxCount is exceeded', async () => {
    store = new AuditStore(db, {
      maxCount: 2,
      maxAgeMs: 60_000,
      maxSizeBytes: 10_000,
    });

    await append('first', 'ALLOW');
    await append('second', 'ALLOW');
    await append('third', 'ALLOW');

    expect(await store.count()).toBe(2);
    expect((await store.getRecent(10)).map(entry => entry.method)).toEqual(['third', 'second']);
  });

  it('prunes rows older than maxAgeMs', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      store = new AuditStore(db, {
        maxCount: 100,
        maxAgeMs: 1_000,
        maxSizeBytes: 10_000,
      });

      nowSpy.mockReturnValueOnce(1_000);
      await append('old', 'ALLOW');

      nowSpy.mockReturnValueOnce(3_000);
      await append('fresh', 'ALLOW');

      expect(await store.count()).toBe(1);
      expect((await store.getRecent(10))[0].method).toBe('fresh');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('exposes explicit rotation enforcement for maintenance paths', async () => {
    store = new AuditStore(db, {
      maxCount: 100,
      maxAgeMs: 1_000,
      maxSizeBytes: 10_000,
    });
    const insert = db.prepare(`
      INSERT INTO gateway_audit (timestamp, method, decision, params_json, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(1_000, 'old', 'ALLOW', null, null, null);
    insert.run(3_000, 'fresh', 'ALLOW', null, null, null);

    await store.enforceRotation(3_000);

    expect(await store.count()).toBe(1);
    expect((await store.getRecent(10))[0].method).toBe('fresh');
  });

  it('prunes oldest rows when approximate payload size exceeds maxSizeBytes', async () => {
    store = new AuditStore(db, {
      maxCount: 100,
      maxAgeMs: 60_000,
      maxSizeBytes: 220,
    });

    await append('first', 'ALLOW', { note: 'a'.repeat(140) });
    await append('second', 'ALLOW', { note: 'b'.repeat(140) });

    expect(await store.count()).toBe(1);
    expect((await store.getRecent(10))[0].method).toBe('second');
  });

  it('rejects invalid rotation configuration', () => {
    expect(() => new AuditStore(db, { maxCount: 0 })).toThrow('maxCount');
    expect(() => new AuditStore(db, { maxAgeMs: 0 })).toThrow('maxAgeMs');
    expect(() => new AuditStore(db, { maxSizeBytes: 0 })).toThrow('maxSizeBytes');
  });

  it('records summary entries with immediate completion', async () => {
    await store.recordSummary({
      method: 'wyoming.session.start',
      decision: 'ALLOW',
      params: { connectionId: 'conn-1', sessionId: 's-1' },
      durationMs: 12.8,
    });

    const entries = await store.getRecent(1);
    expect(entries[0].method).toBe('wyoming.session.start');
    expect(entries[0].durationMs).toBe(12);
    expect(entries[0].error).toBeNull();
  });

  it('creates summary hooks for Wyoming/audit telemetry wiring', async () => {
    const hook = store.createSummaryHook();
    await hook({
      method: 'wyoming.policy.violation',
      decision: 'DENY',
      params: { code: 'RATE_LIMIT_EXCEEDED' },
      error: 'Session exceeded event rate',
    });

    const entries = await store.getRecent(1);
    expect(entries[0].method).toBe('wyoming.policy.violation');
    expect(entries[0].decision).toBe('DENY');
    expect(entries[0].error).toContain('event rate');
  });
});

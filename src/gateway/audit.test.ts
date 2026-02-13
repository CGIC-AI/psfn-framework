import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});

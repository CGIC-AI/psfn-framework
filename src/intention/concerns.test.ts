import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ActiveConcernStore,
  formatActiveConcernsContextBlock,
} from './concerns.js';

function textFixture(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('ActiveConcernStore', () => {
  let db: Database.Database;
  let nowMs: number;
  let idCounter: number;
  let store: ActiveConcernStore;

  beforeEach(() => {
    db = new Database(':memory:');
    nowMs = Date.parse('2026-02-01T10:00:00.000Z');
    idCounter = 0;
    store = new ActiveConcernStore(db, {
      now: () => new Date(nowMs),
      idFactory: () => `concern-${++idCounter}`,
    });
  });

  it('creates concerns with default medium priority/source and medium TTL', () => {
    const created = store.create({
      text: 'Check in tomorrow about the medication reminder.',
      createdAt: '2026-02-01T10:00:00.000Z',
    });

    expect(created.priority).toBe('medium');
    expect(created.source).toBe('agent');
    expect(created.expiresAt).toBe('2026-02-02T10:00:00.000Z');
  });

  it('orders active concerns deterministically by priority, expiry, creation, and id', () => {
    store.create({
      text: 'medium later',
      priority: 'medium',
      createdAt: '2026-02-01T10:10:00.000Z',
      expiresAt: '2026-02-02T11:00:00.000Z',
    });
    store.create({
      text: 'high earlier expiry',
      priority: 'high',
      createdAt: '2026-02-01T10:20:00.000Z',
      expiresAt: '2026-02-02T09:00:00.000Z',
    });
    store.create({
      text: 'high later expiry',
      priority: 'high',
      createdAt: '2026-02-01T09:20:00.000Z',
      expiresAt: '2026-02-02T10:00:00.000Z',
    });
    store.create({
      text: 'low concern',
      priority: 'low',
      createdAt: '2026-02-01T08:20:00.000Z',
      expiresAt: '2026-02-02T12:00:00.000Z',
    });

    const ordered = store.getActiveConcerns();
    expect(ordered.map(item => item.text)).toEqual([
      'high earlier expiry',
      'high later expiry',
      'medium later',
      'low concern',
    ]);
  });

  it('filters active concerns to global + matching contact concerns', () => {
    store.create({
      text: 'Global concern',
      priority: 'medium',
    });
    store.create({
      text: 'Contact A concern',
      contactId: 'contact-a',
      priority: 'high',
    });
    store.create({
      text: 'Contact B concern',
      contactId: 'contact-b',
      priority: 'high',
    });

    const forA = store.getActiveConcerns('contact-a');
    expect(forA.map(item => item.text)).toEqual([
      'Contact A concern',
      'Global concern',
    ]);
  });

  it('excludes resolved and expired concerns from active list', () => {
    const resolved = store.create({
      text: 'Resolve me',
      expiresAt: '2026-02-01T12:00:00.000Z',
    });
    store.create({
      text: 'Expire me',
      expiresAt: '2026-02-01T10:30:00.000Z',
    });
    store.create({
      text: 'Still active',
      expiresAt: '2026-02-01T13:00:00.000Z',
    });

    const result = store.resolveConcern(resolved.id, { outcome: 'Handled' });
    expect(result?.resolvedAt).toBeDefined();
    expect(result?.resolutionOutcome).toBe('Handled');

    nowMs = Date.parse('2026-02-01T11:00:00.000Z');
    const active = store.getActiveConcerns();
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe('Still active');
  });

  it('throws when expiresAt is not after createdAt', () => {
    expect(() => store.create({
      text: 'Bad expiry',
      createdAt: '2026-02-01T10:00:00.000Z',
      expiresAt: '2026-02-01T09:59:59.000Z',
    })).toThrow(/expiresAt must be after createdAt/);
  });

  it('formats active concerns context block with bounded output', () => {
    for (let i = 0; i < 9; i++) {
      store.create({
        text: textFixture(`concern ${i} ${'x'.repeat(32)}`),
        priority: i === 0 ? 'high' : 'low',
        expiresAt: `2026-02-01T${(11 + i).toString().padStart(2, '0')}:00:00.000Z`,
      });
    }

    const block = formatActiveConcernsContextBlock(store.getActiveConcerns(), 6);
    expect(block).toContain('[Active Concerns]');
    expect(block).toContain('additional concerns omitted for context budget');
    const concernLines = block.split('\n').filter(line => line.startsWith('- ('));
    expect(concernLines.length).toBe(7);
  });
});

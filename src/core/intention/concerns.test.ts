import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ActiveConcernStore,
  buildActiveConcernsRuntimeData,
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
    expect(created.status).toBe('active');
    expect(created.salience).toBe(0.5);
    expect(created.sensitivity).toBe('personal');
    expect(created.owner).toBe('companion');
    expect(created.evidenceRefs).toEqual([]);
    expect(created.expiresAt).toBe('2026-02-02T10:00:00.000Z');
  });

  it('creates concerns in differentiated lifecycle states with safe evidence refs', () => {
    const states = [
      'candidate',
      'active',
      'watching',
      'deferred',
      'blocked',
      'resolved',
      'dismissed',
      'suppressed',
    ] as const;

    for (const status of states) {
      const created = store.create({
        text: `Lifecycle ${status}`,
        status,
        evidenceRefs: [{
          kind: 'redacted',
          ref: `audit:${status}`,
          sensitivity: 'redacted',
          redacted: true,
          hash: `sha256:${status}`,
        }],
        salience: 0.7,
        sensitivity: 'confidential',
        owner: 'system',
      });

      expect(created.status).toBe(status);
      expect(created.evidenceRefs).toEqual([{
        kind: 'redacted',
        ref: `audit:${status}`,
        sensitivity: 'redacted',
        redacted: true,
        hash: `sha256:${status}`,
      }]);
      expect(created).not.toHaveProperty('raw');
      if (status === 'resolved' || status === 'dismissed' || status === 'suppressed') {
        expect(created.resolvedAt).toBe(created.createdAt);
      }
    }
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

  it('rejects invalid lifecycle transitions fail-closed', () => {
    const created = store.create({
      text: 'Suppress this source.',
      status: 'suppressed',
    });

    expect(() => store.transitionConcernStatus(created.id, {
      status: 'active',
      evidenceRefs: [{ kind: 'message', ref: 'msg-new' }],
    })).toThrow(/Invalid active concern transition: suppressed -> active/);
    expect(store.getById(created.id)?.status).toBe('suppressed');
  });

  it('transitions through deferred, blocked, dismissed, and suppressed lifecycle states', () => {
    const deferred = store.create({
      text: 'Watch the delayed appointment.',
      status: 'watching',
      nextReviewAt: '2026-02-01T12:00:00.000Z',
    });
    const blocked = store.transitionConcernStatus(deferred.id, {
      status: 'blocked',
      transitionedAt: '2026-02-01T10:05:00.000Z',
      evidenceRefs: [{ kind: 'runtime', ref: 'gate:missing-contact' }],
    });
    expect(blocked).toMatchObject({
      status: 'blocked',
      lastReviewedAt: '2026-02-01T10:05:00.000Z',
    });
    expect(blocked?.evidenceRefs).toEqual([
      { kind: 'runtime', ref: 'gate:missing-contact' },
    ]);

    const dismissed = store.create({ text: 'Dismiss after operator review.' });
    expect(store.transitionConcernStatus(dismissed.id, {
      status: 'dismissed',
      outcome: 'Operator said this is not needed.',
    })?.status).toBe('dismissed');

    const suppressed = store.create({ text: 'Suppress redacted duplicate.' });
    const suppressedResult = store.transitionConcernStatus(suppressed.id, {
      status: 'suppressed',
      evidenceRefs: [{ kind: 'redacted', ref: 'audit:redacted-1', sensitivity: 'redacted' }],
    });
    expect(suppressedResult?.status).toBe('suppressed');
    expect(suppressedResult?.resolutionEvidenceRefs).toEqual([
      { kind: 'redacted', ref: 'audit:redacted-1', sensitivity: 'redacted', redacted: true },
    ]);
  });

  it('lists recently resolved concerns within the configured lookback window', () => {
    const recent = store.create({
      text: 'Recent cleanup reminder',
      contactId: 'contact-a',
    });
    const stale = store.create({
      text: 'Old cleanup reminder',
      contactId: 'contact-a',
    });

    store.resolveConcern(recent.id, {
      outcome: 'Handled during this conversation',
      resolvedAt: '2026-02-01T09:30:00.000Z',
    });
    store.resolveConcern(stale.id, {
      outcome: 'Handled yesterday',
      resolvedAt: '2026-01-31T23:00:00.000Z',
    });

    const recentResolved = store.listRecentlyResolvedConcerns('contact-a', {
      asOf: '2026-02-01T10:00:00.000Z',
      withinMs: 2 * 60 * 60 * 1000,
    });
    expect(recentResolved.map(concern => concern.text)).toEqual([
      'Recent cleanup reminder',
    ]);
  });

  it('matches similar recently resolved concerns to suppress duplicate recreation', () => {
    const created = store.create({
      text: 'Follow up on medication tomorrow morning',
      contactId: 'contact-a',
    });
    store.resolveConcern(created.id, {
      outcome: 'Handled already',
      resolvedAt: '2026-02-01T09:45:00.000Z',
    });

    const match = store.findRecentlyResolvedSimilarConcern({
      text: 'Follow up on medication tomorrow',
      contactId: 'contact-a',
      asOf: '2026-02-01T10:00:00.000Z',
      withinMs: 60 * 60 * 1000,
    });
    expect(match?.id).toBe(created.id);

    const staleMatch = store.findRecentlyResolvedSimilarConcern({
      text: 'Follow up on medication tomorrow',
      contactId: 'contact-a',
      asOf: '2026-02-02T10:00:00.000Z',
      withinMs: 60 * 60 * 1000,
    });
    expect(staleMatch).toBeNull();
  });

  it('dedupes active concerns by merging lifecycle metadata', () => {
    const first = store.create({
      text: 'Follow up on hydration tomorrow',
      priority: 'low',
      status: 'candidate',
      evidenceRefs: [{ kind: 'message', ref: 'msg-1' }],
      expiresAt: '2026-02-01T12:00:00.000Z',
    });
    const second = store.create({
      text: 'Follow up on hydration tomorrow morning',
      priority: 'high',
      status: 'blocked',
      evidenceRefs: [{ kind: 'appraisal', ref: 'appraisal-2' }],
      expiresAt: '2026-02-01T14:00:00.000Z',
      salience: 0.9,
    });

    expect(second.id).toBe(first.id);
    expect(second.priority).toBe('high');
    expect(second.status).toBe('blocked');
    expect(second.salience).toBe(0.9);
    expect(second.expiresAt).toBe('2026-02-01T14:00:00.000Z');
    expect(second.evidenceRefs).toEqual([
      { kind: 'message', ref: 'msg-1' },
      { kind: 'appraisal', ref: 'appraisal-2' },
    ]);
    expect(store.list({ includeExpired: true })).toHaveLength(1);
  });

  it('resolves stale duplicate concerns before creating another prompt-facing thread', () => {
    const stale = store.create({
      text: 'Follow up on hydration tomorrow morning',
      priority: 'medium',
      status: 'watching',
      createdAt: '2026-02-01T08:00:00.000Z',
      expiresAt: '2026-02-01T09:00:00.000Z',
    });

    const duplicate = store.create({
      text: 'Follow up on hydration tomorrow',
      priority: 'high',
      createdAt: '2026-02-01T10:00:00.000Z',
      evidenceRefs: [{ kind: 'message', ref: 'msg-hydration-repeat' }],
    });

    expect(duplicate.id).toBe(stale.id);
    expect(duplicate.status).toBe('resolved');
    expect(duplicate.resolutionOutcome).toBe('Resolved as stale after review window elapsed.');
    expect(duplicate.resolutionEvidenceRefs).toEqual([
      { kind: 'runtime', ref: 'concern-create-stale-sweep:2026-02-01T10:00:00.000Z' },
    ]);
    expect(store.getActiveConcerns()).toEqual([]);
    expect(store.list({ includeResolved: true, includeExpired: true })).toHaveLength(1);
  });

  it('records split children with parent provenance', () => {
    const parent = store.create({
      text: 'Separate mixed deployment and care follow-up thread',
    });
    const deployment = store.create({
      text: 'Track deployment rollback risk separately',
      splitFromId: parent.id,
      status: 'blocked',
    });
    const care = store.create({
      text: 'Track care check-in separately',
      splitFromId: parent.id,
      status: 'watching',
    });
    const resolvedParent = store.transitionConcernStatus(parent.id, {
      status: 'resolved',
      outcome: `Split into ${deployment.id} and ${care.id}`,
    });

    expect(deployment.splitFromId).toBe(parent.id);
    expect(care.splitFromId).toBe(parent.id);
    expect(resolvedParent).toMatchObject({
      status: 'resolved',
      resolutionOutcome: `Split into ${deployment.id} and ${care.id}`,
    });
  });

  it('resolves stale unresolved concerns explicitly', () => {
    store.create({
      text: 'Expired watch item',
      status: 'watching',
      expiresAt: '2026-02-01T10:30:00.000Z',
    });
    store.create({
      text: 'Still future item',
      status: 'active',
      expiresAt: '2026-02-01T13:00:00.000Z',
    });

    const stale = store.resolveStaleConcerns({
      asOf: '2026-02-01T11:00:00.000Z',
      evidenceRefs: [{ kind: 'runtime', ref: 'stale-sweep:2026-02-01T11' }],
    });

    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      text: 'Expired watch item',
      status: 'resolved',
      resolutionOutcome: 'Resolved as stale after review window elapsed.',
    });
    expect(store.getActiveConcerns().map(concern => concern.text)).toEqual(['Still future item']);
  });

  it('keeps recently resolved concerns terminal until explicit new evidence reopens them', () => {
    const resolved = store.create({
      text: 'Check the medication reminder',
      contactId: 'contact-a',
    });
    store.resolveConcern(resolved.id, {
      outcome: 'Handled already',
      resolvedAt: '2026-02-01T09:45:00.000Z',
    });

    const duplicate = store.create({
      text: 'Check the medication reminder',
      contactId: 'contact-a',
      createdAt: '2026-02-01T10:00:00.000Z',
    });
    expect(duplicate.id).toBe(resolved.id);
    expect(duplicate.status).toBe('resolved');
    expect(store.getActiveConcerns('contact-a')).toHaveLength(0);

    expect(() => store.transitionConcernStatus(resolved.id, {
      status: 'active',
    })).toThrow(/requires new safe evidence refs/);

    const reopened = store.create({
      text: 'Check the medication reminder',
      contactId: 'contact-a',
      createdAt: '2026-02-01T10:05:00.000Z',
      reopenResolved: true,
      evidenceRefs: [{ kind: 'message', ref: 'msg-new-medication-update' }],
    });
    expect(reopened.id).toBe(resolved.id);
    expect(reopened.status).toBe('active');
    expect(reopened.resolvedAt).toBeUndefined();
    expect(reopened.evidenceRefs).toEqual([
      { kind: 'message', ref: 'msg-new-medication-update' },
    ]);
  });

  it('throws when expiresAt is not after createdAt', () => {
    expect(() => store.create({
      text: 'Bad expiry',
      createdAt: '2026-02-01T10:00:00.000Z',
      expiresAt: '2026-02-01T09:59:59.000Z',
    })).toThrow(/expiresAt must be after createdAt/);
  });

  it('formats active concerns context block with bounded output', () => {
    const uniqueTopics = [
      'medication reminder logistics',
      'calendar scheduling conflict',
      'database migration rollback',
      'voice latency regression',
      'breakfast habit followup',
      'sleep schedule drift',
      'hydration routine check',
      'avatar render pipeline',
      'backup verification audit',
    ];
    for (let i = 0; i < 9; i++) {
      store.create({
        text: textFixture(uniqueTopics[i]!),
        priority: i === 0 ? 'high' : 'low',
        expiresAt: `2026-02-01T${(11 + i).toString().padStart(2, '0')}:00:00.000Z`,
      });
    }

    const block = formatActiveConcernsContextBlock(store.getActiveConcerns(), 6);
    expect(block).toContain('<open_threads>');
    expect(block).toContain('Treat these as soft threads to verify, not alarms that must dominate the turn.');
    expect(block).toContain('additional lower-salience threads omitted');
    const concernLines = block.split('\n').filter(line => line.startsWith('- '));
    expect(concernLines.length).toBe(7);
  });

  it('builds atomic active-concern runtime data without the prose opener', () => {
    store.create({
      text: textFixture('medication reminder logistics'),
      priority: 'high',
      expiresAt: '2026-02-01T11:00:00.000Z',
    });
    store.create({
      text: textFixture('sleep schedule drift'),
      priority: 'low',
      expiresAt: '2026-02-01T12:00:00.000Z',
    });
    store.create({
      text: textFixture('hydration routine check'),
      priority: 'low',
      expiresAt: '2026-02-01T13:00:00.000Z',
    });

    const runtimeData = buildActiveConcernsRuntimeData(store.getActiveConcerns(), 2);

    expect(runtimeData.totalCount).toBe(3);
    expect(runtimeData.topPriorities).toEqual(['high', 'low']);
    expect(runtimeData.omittedCount).toBe(1);
    expect(runtimeData.topLines).toHaveLength(2);
    expect(runtimeData.topLines[0]).toMatch(/^- medication reminder logistics \[high; revisit before /);
    expect(runtimeData.topLines[1]).toMatch(/^- sleep schedule drift \[low; revisit before /);
  });
});

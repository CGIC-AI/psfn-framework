// htm9.11 — Garden intake quarantine approval service tests: the server-side
// double-confirm token flow, the release/discard decisions, and the
// always-allow/always-deny source-list flywheel.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIntakeEnvelope,
  transitionIntakeEnvelope,
  type IntakeEnvelope,
} from '../../../shared/contracts/intake-envelope.js';
import { createIntakeQuarantineStore, type IntakeQuarantineStore } from '../../../core/cogsec/intake/quarantine-store.js';
import type {
  IntakeSourceListEntry,
  IntakeSourceListName,
} from '../../../system/config/intake-policy-config.js';
import type { CogSecCreateEventInput, CogSecUpdateEventInput } from '../../../core/cogsec/events.js';
import {
  createAdminIntakeQuarantineService,
  type AdminIntakeQuarantineService,
} from './intake-quarantine-service.js';

const NOW = 1_750_000_000_000;

function makeQuarantinedEnvelope(input: {
  id?: string;
  originRef?: string;
  withL3Fields?: boolean;
} = {}): IntakeEnvelope {
  const sha256 = 'b'.repeat(64);
  let envelope = createIntakeEnvelope({
    sourceClass: 'web_fetch',
    sourceRiskTier: 'untrusted',
    contentRef: { store: 'intake-quarantine', ref: `sha256:${sha256}`, sha256, sizeBytes: 42 },
    origin: { ref: input.originRef ?? 'https://suspect.example/article' },
    ...(input.id !== undefined ? { id: input.id } : {}),
    atMs: NOW,
  });
  envelope = transitionIntakeEnvelope(envelope, {
    to: 'screened',
    actor: 'test:screening',
    reason: 'l1:injection/override_attempt',
    atMs: NOW,
    decision: {
      action: 'quarantine',
      reason: 'l1:injection/override_attempt',
      decidedBy: 'screening',
      decidedAtMs: NOW,
    },
    riskLabels: ['injection/override_attempt'],
    scores: { 'l1-rule-engine': 1, 'l3-heavy-screener': 0.93 },
    ...(input.withL3Fields === false
      ? {}
      : {
        extractedFields: {
          l3_summary: 'An article that attempts an instruction override.',
          l3_why_flagged: 'Contains an embedded override attempt aimed at the assistant.',
        },
      }),
  });
  return transitionIntakeEnvelope(envelope, {
    to: 'quarantined',
    actor: 'test:screening',
    reason: "routed per screening decision 'quarantine'",
    atMs: NOW,
  });
}

type Lists = Record<IntakeSourceListName, IntakeSourceListEntry[]>;

function emptyLists(): Lists {
  return { trustedSites: [], deniedSites: [], trustedPeople: [], deniedPeople: [] };
}

describe('admin intake quarantine service (htm9.11)', () => {
  let dir: string;
  let clock: number;
  let store: IntakeQuarantineStore;
  let lists: Lists;
  let mutations: Array<{ action: string; list: string; pattern: string }>;
  let createdEvents: CogSecCreateEventInput[];
  let updatedEvents: Array<{ caseId: string; input: CogSecUpdateEventInput }>;
  let service: AdminIntakeQuarantineService;

  const buildService = (overrides: { confirmTokenTtlMs?: number } = {}) => createAdminIntakeQuarantineService({
    store,
    settingsService: {
      getIntakeSourceLists: () => lists,
      mutateIntakeSourceList: vi.fn((input) => {
        mutations.push({ action: input.action, list: input.list, pattern: input.pattern });
        lists = {
          ...lists,
          [input.list]: [
            ...lists[input.list],
            { pattern: input.pattern, addedBy: 'operator', addedAt: clock },
          ],
        };
        return { ok: true, message: 'added' };
      }),
    },
    cogSecEvents: () => ({
      createEvent: (input: CogSecCreateEventInput) => {
        createdEvents.push(input);
        return {
          caseId: `cogsec_case_${String(createdEvents.length)}`,
          type: input.type,
          severity: input.severity,
          status: input.status ?? 'open',
          sourceChannelId: input.sourceChannelId,
          affectedLogicalSessionIds: [],
          affectedMessageRanges: [],
          sealedForensicPayloadRefs: [],
          sealedForensicPayloadHashes: input.sealedForensicPayloadHashes ?? [],
          tombstonedL0RowCount: 0,
          affectedArtifacts: {},
          actions: [],
          actor: input.actor ?? 'system',
          createdAt: new Date(clock).toISOString(),
          updatedAt: new Date(clock).toISOString(),
          safeAgentSummary: input.safeAgentSummary,
          resultCounters: {},
          epochCuts: [],
        };
      },
      updateEvent: (caseId: string, input: CogSecUpdateEventInput) => {
        updatedEvents.push({ caseId, input });
        return {} as never;
      },
    }),
    now: () => clock,
    ...(overrides.confirmTokenTtlMs !== undefined
      ? { confirmTokenTtlMs: overrides.confirmTokenTtlMs }
      : {}),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intake-quarantine-service-'));
    clock = NOW;
    store = createIntakeQuarantineStore(join(dir, 'intake-quarantine.json'), {
      itemTtlHours: 168,
      maxHeldItems: 100,
      now: () => clock,
    });
    lists = emptyLists();
    mutations = [];
    createdEvents = [];
    updatedEvents = [];
    service = buildService();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function holdItem(input: {
    id?: string;
    originRef?: string;
    safeRepresentationText?: string;
    canonicalContactId?: string;
    withL3Fields?: boolean;
  } = {}): IntakeEnvelope {
    const envelope = makeQuarantinedEnvelope(input);
    store.hold({
      envelope,
      mode: 'enforce',
      rawText: 'the suspicious raw content',
      ...(input.safeRepresentationText !== undefined
        ? { safeRepresentationText: input.safeRepresentationText }
        : {}),
      ...(input.canonicalContactId !== undefined
        ? { canonicalContactId: input.canonicalContactId }
        : {}),
      sourceChannelId: 'discord:chan-1',
      atMs: clock,
    });
    return envelope;
  }

  it('lists items with the operator-facing detail (scores, labels, TTL, flywheel target)', () => {
    const envelope = holdItem({ safeRepresentationText: 'Summary: a neutral description.' });
    clock = NOW + 60_000;
    const { items } = service.listItems();
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.id).toBe(envelope.id);
    expect(item.status).toBe('held');
    expect(item.sourceClass).toBe('web_fetch');
    expect(item.riskLabels).toContain('injection/override_attempt');
    expect(item.scores['l1-rule-engine']).toBe(1);
    expect(item.scores['l3-heavy-screener']).toBe(0.93);
    expect(item.whyFlagged).toContain('override attempt');
    expect(item.ttlRemainingMs).toBe(168 * 3_600_000 - 60_000);
    expect(item.safeRepresentationAvailable).toBe(true);
    expect(item.flywheelTarget).toEqual({ kind: 'site', pattern: 'suspect.example' });
    expect(item.contentSha256).toBe('b'.repeat(64));
  });

  it('exposes raw text, extracted fields, and the transition journal in the detail view', () => {
    const envelope = holdItem();
    const detail = service.getItem(envelope.id);
    expect(detail?.rawText).toBe('the suspicious raw content');
    expect(detail?.extractedFields.l3_summary).toContain('instruction override');
    expect(detail?.transitions.map((record) => record.to))
      .toEqual(['screened', 'quarantined']);
    expect(service.getItem('nope-not-here-0001')).toBeUndefined();
  });

  describe('server-side double-confirm', () => {
    it('release requires a confirm token from a prior beginDecision (two POSTs)', () => {
      const envelope = holdItem();
      const denied = service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: 'forged-token',
        reason: 'no confirmation step',
      });
      expect(denied).toMatchObject({ ok: false, status: 403 });
      expect(store.getById(envelope.id)?.status).toBe('held');

      const begin = service.beginDecision({ id: envelope.id, action: 'release_raw' });
      if (!begin.ok) throw new Error('begin failed');
      expect(begin.confirmToken).toMatch(/^[0-9a-f]{64}$/);
      expect(begin.summary).toContain('RAW');

      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: begin.confirmToken,
        reason: 'reviewed the raw content; benign',
      });
      expect(resolved.ok).toBe(true);
      expect(store.getById(envelope.id)?.status).toBe('released_raw');
      expect(store.getById(envelope.id)?.envelope.state).toBe('human_released');
    });

    it('tokens are single-use, even when resolution fails', () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'discard' });
      if (!begin.ok) throw new Error('begin failed');

      // Wrong action consumes the token...
      const wrongAction = service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: begin.confirmToken,
        reason: 'switcheroo',
      });
      expect(wrongAction).toMatchObject({ ok: false, status: 403 });

      // ...so the original decision no longer goes through either.
      const replay = service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        confirmToken: begin.confirmToken,
        reason: 'retry',
      });
      expect(replay).toMatchObject({ ok: false, status: 403 });
      expect(store.getById(envelope.id)?.status).toBe('held');
    });

    it('tokens expire after the short TTL', () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'discard' });
      if (!begin.ok) throw new Error('begin failed');
      expect(begin.expiresAtMs).toBe(NOW + 2 * 60_000);

      clock = NOW + 2 * 60_000 + 1;
      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        confirmToken: begin.confirmToken,
        reason: 'too late',
      });
      expect(resolved).toMatchObject({ ok: false, status: 403 });
      expect((resolved as { message: string }).message).toContain('expired');
    });

    it('any source-list change between confirm and decide invalidates the token', () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'release_raw' });
      if (!begin.ok) throw new Error('begin failed');

      // The operator (or another session) edits the lists in between.
      lists = {
        ...lists,
        deniedSites: [{ pattern: 'unrelated.example', addedBy: 'operator', addedAt: clock }],
      };

      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: begin.confirmToken,
        reason: 'stale confirmation',
      });
      expect(resolved).toMatchObject({ ok: false, status: 409 });
      expect((resolved as { message: string }).message).toContain('source lists changed');
      expect(store.getById(envelope.id)?.status).toBe('held');
    });

    it('token is bound to the flywheel option too', () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'discard' });
      if (!begin.ok) throw new Error('begin failed');
      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
        confirmToken: begin.confirmToken,
        reason: 'added a list action after confirming',
      });
      expect(resolved).toMatchObject({ ok: false, status: 403 });
      expect(mutations).toHaveLength(0);
    });

    it('a decision on an already-decided item is refused at both steps', () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'discard' });
      if (!begin.ok) throw new Error('begin failed');
      service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        confirmToken: begin.confirmToken,
        reason: 'first decision',
      });

      expect(service.beginDecision({ id: envelope.id, action: 'release_raw' }))
        .toMatchObject({ ok: false, status: 409 });
    });
  });

  describe('release-sanitized availability', () => {
    it('is refused at confirm time when the item has no safe representation', () => {
      const envelope = holdItem({ withL3Fields: false });
      const begin = service.beginDecision({ id: envelope.id, action: 'release_sanitized' });
      expect(begin).toMatchObject({ ok: false, status: 409 });
      expect((begin as { message: string }).message).toContain('release-sanitized is unavailable');
    });

    it('releases the safe representation when one exists', () => {
      const envelope = holdItem({ safeRepresentationText: 'Summary: a neutral description.' });
      const begin = service.beginDecision({ id: envelope.id, action: 'release_sanitized' });
      if (!begin.ok) throw new Error('begin failed');
      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'release_sanitized',
        confirmToken: begin.confirmToken,
        reason: 'summary is enough for the companion',
      });
      expect(resolved.ok).toBe(true);
      expect(store.getById(envelope.id)?.envelope.state).toBe('human_released_sanitized');
    });
  });

  describe('the flywheel (per-source policy updates)', () => {
    it('always-deny on a site origin adds the host to deniedSites via the settings path', () => {
      const envelope = holdItem({ originRef: 'https://evil.example/post' });
      const begin = service.beginDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
      });
      if (!begin.ok) throw new Error('begin failed');
      expect(begin.summary).toContain("always-deny site 'evil.example'");

      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
        confirmToken: begin.confirmToken,
        reason: 'hostile source',
      });
      expect(resolved.ok).toBe(true);
      expect(mutations).toEqual([{ action: 'add', list: 'deniedSites', pattern: 'evil.example' }]);
    });

    it('always-allow on a person origin adds the canonical contact id to trustedPeople', () => {
      const envelope = holdItem({
        id: 'env-person-000001',
        originRef: 'discord:chan-1:msg-9',
        canonicalContactId: 'contact:alice',
      });
      const begin = service.beginDecision({
        id: envelope.id,
        action: 'release_raw',
        sourceList: 'always_allow',
      });
      if (!begin.ok) throw new Error('begin failed');
      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        sourceList: 'always_allow',
        confirmToken: begin.confirmToken,
        reason: 'known-good sender',
      });
      expect(resolved.ok).toBe(true);
      expect(mutations).toEqual([{ action: 'add', list: 'trustedPeople', pattern: 'contact:alice' }]);
    });

    it('is idempotent when the pattern is already listed', () => {
      lists = {
        ...lists,
        deniedSites: [{ pattern: 'evil.example', addedBy: 'operator', addedAt: NOW }],
      };
      const envelope = holdItem({ originRef: 'https://evil.example/post' });
      const begin = service.beginDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
      });
      if (!begin.ok) throw new Error('begin failed');
      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
        confirmToken: begin.confirmToken,
        reason: 'already denied',
      });
      expect(resolved.ok).toBe(true);
      expect((resolved as { message: string }).message).toContain('already contains');
      expect(mutations).toHaveLength(0);
    });

    it('is unavailable when the item has no listable source', () => {
      const envelope = holdItem({ id: 'env-no-target-0001', originRef: 'tool:call-77' });
      const begin = service.beginDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
      });
      expect(begin).toMatchObject({ ok: false, status: 400 });
      expect((begin as { message: string }).message).toContain('no listable source');
    });

    it('aborts the decision (item stays held) when the source-list write fails', () => {
      service = createAdminIntakeQuarantineService({
        store,
        settingsService: {
          getIntakeSourceLists: () => lists,
          mutateIntakeSourceList: () => ({ ok: false, message: 'contradiction with trustedSites' }),
        },
        cogSecEvents: () => {
          throw new Error('must not reach the cogsec ledger');
        },
        now: () => clock,
      });
      const envelope = holdItem({ originRef: 'https://evil.example/post' });
      const begin = service.beginDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
      });
      if (!begin.ok) throw new Error('begin failed');
      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
        confirmToken: begin.confirmToken,
        reason: 'hostile source',
      });
      expect(resolved).toMatchObject({ ok: false, status: 409 });
      expect((resolved as { message: string }).message).toContain('decision NOT applied');
      expect(store.getById(envelope.id)?.status).toBe('held');
    });
  });

  describe('cogsec ledger', () => {
    it('writes an applying → applied intake_firewall event around every decision', () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'release_raw' });
      if (!begin.ok) throw new Error('begin failed');
      const resolved = service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: begin.confirmToken,
        reason: 'reviewed; benign',
      });
      expect(resolved.ok).toBe(true);
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]).toMatchObject({
        type: 'intake_firewall',
        severity: 'medium',
        status: 'applying',
        sourceChannelId: 'discord:chan-1',
        actor: 'operator:garden',
        sealedForensicPayloadHashes: [`sha256:${'b'.repeat(64)}`],
      });
      expect(updatedEvents).toEqual([
        { caseId: 'cogsec_case_1', input: expect.objectContaining({ status: 'applied' }) },
      ]);
      expect((resolved as { cogSecCaseId: string }).cogSecCaseId).toBe('cogsec_case_1');
    });
  });
});

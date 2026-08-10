// htm9.11 — Garden intake quarantine approval service tests: the server-side
// double-confirm token flow, the release/discard decisions, and the
// always-allow/always-deny source-list flywheel.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  type IntakeReleaseRedeliveryInput,
} from './intake-quarantine-service.js';
import type { GardenRequestContext } from '../garden-request-context.js';

const NOW = 1_750_000_000_000;

function fleetContext(principalId: string, sessionAuthzVersion = 1): GardenRequestContext {
  return {
    kind: 'fleet_principal',
    actor: {
      principalId,
      contactId: `contact-${principalId}`,
      sessionRecordId: `session-${principalId}`,
      role: 'admin',
    },
    resource: { companionId: '11111111-1111-4111-8111-111111111111' },
    versions: {
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      sessionAuthnVersion: 1,
      sessionAuthzVersion,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    },
  } as unknown as GardenRequestContext;
}

function makeQuarantinedEnvelope(input: {
  id?: string;
  originRef?: string;
  withL3Fields?: boolean;
  withRuleMatch?: boolean;
  ruleMatchTotalCount?: number;
  decisionReason?: string;
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
  const decisionReason = input.decisionReason ?? 'l1:injection/override_attempt';
  envelope = transitionIntakeEnvelope(envelope, {
    to: 'screened',
    actor: 'test:screening',
    reason: decisionReason,
    atMs: NOW,
    decision: {
      action: 'quarantine',
      reason: decisionReason,
      decidedBy: 'screening',
      decidedAtMs: NOW,
      ...(input.withRuleMatch
        ? {
          ruleMatches: [{
            ruleId: 'injection_ignore_instructions',
            kind: 'phrase' as const,
            startOffset: 0,
            endOffset: 32,
            excerpt: 'ignore all previous instructions',
          }],
          ...(input.ruleMatchTotalCount !== undefined
            ? {
              ruleMatchTotalCount: input.ruleMatchTotalCount,
              ruleMatchesTruncated: input.ruleMatchTotalCount > 1,
            }
            : {}),
        }
        : {}),
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
  let quarantinePath: string;
  let clock: number;
  let store: IntakeQuarantineStore;
  let lists: Lists;
  let mutations: Array<{ action: string; list: string; pattern: string }>;
  let createdEvents: CogSecCreateEventInput[];
  let updatedEvents: Array<{ caseId: string; input: CogSecUpdateEventInput }>;
  let redeliveries: IntakeReleaseRedeliveryInput[];
  let redeliverResult: (input: IntakeReleaseRedeliveryInput) => {
    delivered: boolean;
    channelId?: string;
    entryId?: number | null;
    reason?: string;
  };
  let service: AdminIntakeQuarantineService;

  const buildService = (overrides: {
    confirmTokenTtlMs?: number;
    onQueueChanged?: () => void;
  } = {}) => createAdminIntakeQuarantineService({
    store,
    redeliverReleased: (input) => {
      redeliveries.push(input);
      return redeliverResult(input);
    },
    settingsService: {
      getIntakeSourceLists: () => lists,
      mutateIntakeSourceList: vi.fn(async (input) => {
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
    ...(overrides.onQueueChanged ? { onQueueChanged: overrides.onQueueChanged } : {}),
    ...(overrides.confirmTokenTtlMs !== undefined
      ? { confirmTokenTtlMs: overrides.confirmTokenTtlMs }
      : {}),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intake-quarantine-service-'));
    quarantinePath = join(dir, 'intake-quarantine.json');
    clock = NOW;
    store = createIntakeQuarantineStore(quarantinePath, {
      itemTtlHours: 168,
      maxHeldItems: 100,
      now: () => clock,
    });
    lists = emptyLists();
    mutations = [];
    createdEvents = [];
    updatedEvents = [];
    redeliveries = [];
    redeliverResult = (input) => ({
      delivered: true,
      channelId: input.sourceChannelId ?? 'discord:chan-1',
      entryId: 4242,
    });
    service = buildService();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('signals queue consumers only after a decision is successfully applied', async () => {
    const onQueueChanged = vi.fn();
    const signalingService = buildService({ onQueueChanged });
    const entry = holdItem();
    const begun = signalingService.beginDecision({ id: entry.id, action: 'discard' });
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error('expected confirmation token');

    expect((await signalingService.resolveDecision({
      id: entry.id,
      action: 'discard',
      confirmToken: begun.confirmToken,
      reason: 'hostile content',
    })).ok).toBe(true);
    expect(onQueueChanged).toHaveBeenCalledTimes(1);
  });

  function holdItem(input: {
    id?: string;
    originRef?: string;
    safeRepresentationText?: string;
    canonicalContactId?: string;
    withL3Fields?: boolean;
    withRuleMatch?: boolean;
    ruleMatchTotalCount?: number;
    decisionReason?: string;
    sourceChannelId?: string | null;
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
      ...(input.sourceChannelId !== null
        ? { sourceChannelId: input.sourceChannelId ?? 'discord:chan-1' }
        : {}),
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
    expect(item.holdReason).toBe('detection');
    expect(item.sourceClass).toBe('web_fetch');
    expect(item.riskLabels).toContain('injection/override_attempt');
    expect(item.scores['l1-rule-engine']).toBe(1);
    expect(item.scores['l3-heavy-screener']).toBe(0.93);
    expect(item.whyFlagged).toContain('override attempt');
    expect(item.ttlRemainingMs).toBe(168 * 3_600_000 - 60_000);
    expect(item.safeRepresentationAvailable).toBe(true);
    expect(item.flywheelTarget).toEqual({ kind: 'site', pattern: 'suspect.example' });
    expect(item.contentSha256).toBe('b'.repeat(64));
    expect(item.ruleMatches).toEqual([]);
  });

  it.each([
    'l2-fail-closed:L2 screener response was not valid JSON',
    'l3-fail-closed:z-ai/glm-4.5-air: summary-instead-of-quote violation',
    'vision-screener-fail-closed:vision screener response contained no assistant content',
  ])('labels fail-closed screener reliability holds separately from detections: %s', (decisionReason) => {
    holdItem({ decisionReason });

    expect(service.listItems().items[0]).toMatchObject({
      status: 'held',
      holdReason: 'screener_malfunction',
      screeningDecisionReason: decisionReason,
    });
  });

  it('surfaces L1 rule ids and safe match evidence while legacy envelopes remain empty', () => {
    const envelope = holdItem({ withRuleMatch: true, ruleMatchTotalCount: 39 });
    const item = service.listItems().items[0];

    expect(item.id).toBe(envelope.id);
    expect(item.ruleMatches).toEqual([{
      ruleId: 'injection_ignore_instructions',
      kind: 'phrase',
      startOffset: 0,
      endOffset: 32,
      excerpt: 'ignore all previous instructions',
    }]);
    expect(item).toMatchObject({
      ruleMatchTotalCount: 39,
      ruleMatchesTruncated: true,
    });
  });

  it('surfaces isolated provenance failure and refuses release while keeping discard available', () => {
    const envelope = holdItem({ withRuleMatch: true });
    const persisted = JSON.parse(readFileSync(quarantinePath, 'utf8')) as {
      entries: Array<{ envelope: { decision: { ruleMatches?: Array<Record<string, unknown>> } } }>;
    };
    const ruleMatch = persisted.entries[0]?.envelope.decision.ruleMatches?.[0];
    if (!ruleMatch) throw new Error('Malformed-rule fixture must include persisted provenance');
    ruleMatch.kind = 'glob';
    writeFileSync(quarantinePath, JSON.stringify(persisted), 'utf8');

    expect(service.listItems().items[0]).toMatchObject({
      id: envelope.id,
      status: 'held',
      ruleMatches: [],
      ruleMatchProvenanceUnavailable: true,
    });
    expect(service.beginDecision({ id: envelope.id, action: 'release_raw' }))
      .toMatchObject({ ok: false, status: 409 });
    expect(service.beginDecision({ id: envelope.id, action: 'discard' }))
      .toMatchObject({ ok: true });
  });

  // hrmrq.54: a containment-bypass attempt (reading the held item's on-disk
  // artifact) must be visible to the operator reviewing the case.
  it('surfaces recorded artifact access attempts on the queue item view (hrmrq.54)', () => {
    const envelope = holdItem();
    store.recordAccessAttempt({
      id: envelope.id,
      path: '/companion/files/doc.md.parsed.txt',
      via: 'gateway:fs.read',
      atMs: clock,
    });
    const { items } = service.listItems();
    expect(items[0].contentAccessAttempts).toEqual([
      {
        path: '/companion/files/doc.md.parsed.txt',
        via: 'gateway:fs.read',
        at: new Date(clock).toISOString(),
      },
    ]);
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
    it('release requires a confirm token from a prior beginDecision (two POSTs)', async () => {
      const envelope = holdItem();
      const denied = await service.resolveDecision({
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

      const resolved = await service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: begin.confirmToken,
        reason: 'reviewed the raw content; benign',
      });
      expect(resolved.ok).toBe(true);
      expect(store.getById(envelope.id)?.status).toBe('released_raw');
      expect(store.getById(envelope.id)?.envelope.state).toBe('human_released');
    });

    it('tokens are single-use, even when resolution fails', async () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'discard' });
      if (!begin.ok) throw new Error('begin failed');

      // Wrong action consumes the token...
      const wrongAction = await service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: begin.confirmToken,
        reason: 'switcheroo',
      });
      expect(wrongAction).toMatchObject({ ok: false, status: 403 });

      // ...so the original decision no longer goes through either.
      const replay = await service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        confirmToken: begin.confirmToken,
        reason: 'retry',
      });
      expect(replay).toMatchObject({ ok: false, status: 403 });
      expect(store.getById(envelope.id)?.status).toBe('held');
    });

    it('binds a token to the exact fleet principal and authority versions', async () => {
      const envelope = holdItem();
      const begin = service.beginDecision(
        { id: envelope.id, action: 'discard' },
        fleetContext('principal-a'),
      );
      if (!begin.ok) throw new Error('begin failed');

      const resolved = await service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        confirmToken: begin.confirmToken,
        reason: 'cross-principal attempt',
      }, fleetContext('principal-b'));

      expect(resolved).toMatchObject({ ok: false, status: 403 });
      expect((resolved as { message: string }).message).toContain('different authority snapshot');
      expect(store.getById(envelope.id)?.status).toBe('held');
    });

    it('tokens expire after the short TTL', async () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'discard' });
      if (!begin.ok) throw new Error('begin failed');
      expect(begin.expiresAtMs).toBe(NOW + 2 * 60_000);

      clock = NOW + 2 * 60_000 + 1;
      const resolved = await service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        confirmToken: begin.confirmToken,
        reason: 'too late',
      });
      expect(resolved).toMatchObject({ ok: false, status: 403 });
      expect((resolved as { message: string }).message).toContain('expired');
    });

    it('any source-list change between confirm and decide invalidates the token', async () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'release_raw' });
      if (!begin.ok) throw new Error('begin failed');

      // The operator (or another session) edits the lists in between.
      lists = {
        ...lists,
        deniedSites: [{ pattern: 'unrelated.example', addedBy: 'operator', addedAt: clock }],
      };

      const resolved = await service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: begin.confirmToken,
        reason: 'stale confirmation',
      });
      expect(resolved).toMatchObject({ ok: false, status: 409 });
      expect((resolved as { message: string }).message).toContain('source lists changed');
      expect(store.getById(envelope.id)?.status).toBe('held');
    });

    it('token is bound to the flywheel option too', async () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'discard' });
      if (!begin.ok) throw new Error('begin failed');
      const resolved = await service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
        confirmToken: begin.confirmToken,
        reason: 'added a list action after confirming',
      });
      expect(resolved).toMatchObject({ ok: false, status: 403 });
      expect(mutations).toHaveLength(0);
    });

    it('a decision on an already-decided item is refused at both steps', async () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'discard' });
      if (!begin.ok) throw new Error('begin failed');
      await service.resolveDecision({
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

    it('releases the safe representation when one exists', async () => {
      const envelope = holdItem({ safeRepresentationText: 'Summary: a neutral description.' });
      const begin = service.beginDecision({ id: envelope.id, action: 'release_sanitized' });
      if (!begin.ok) throw new Error('begin failed');
      const resolved = await service.resolveDecision({
        id: envelope.id,
        action: 'release_sanitized',
        confirmToken: begin.confirmToken,
        reason: 'summary is enough for the companion',
      });
      expect(resolved.ok).toBe(true);
      expect(store.getById(envelope.id)?.envelope.state).toBe('human_released_sanitized');
    });
  });

  describe('honest re-delivery of released content (jvbt)', () => {
    const releaseRaw = async (envelope: IntakeEnvelope) => {
      const begin = service.beginDecision({ id: envelope.id, action: 'release_raw' });
      if (!begin.ok) throw new Error('begin failed');
      return service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: begin.confirmToken,
        reason: 'false positive; content is fine',
      });
    };

    it('re-delivers the raw content with the surviving envelope provenance', async () => {
      const envelope = holdItem();
      const resolved = await releaseRaw(envelope);
      expect(resolved.ok).toBe(true);
      expect(redeliveries).toHaveLength(1);
      const delivered = redeliveries[0];
      expect(delivered.action).toBe('release_raw');
      expect(delivered.content).toBe('the suspicious raw content');
      expect(delivered.sourceChannelId).toBe('discord:chan-1');
      // The envelope is terminal-released but keeps its untrusted origin so
      // the delivery stays gated at the sinks (never laundered as trusted).
      expect(delivered.envelope.state).toBe('human_released');
      expect(delivered.envelope.sourceClass).toBe('web_fetch');
      expect(delivered.envelope.sourceRiskTier).toBe('untrusted');
      if (resolved.ok) {
        expect(resolved.message).toContain('re-delivered it into discord:chan-1');
      }
    });

    it('recovers a Discord carrying channel from canonical provenance for a legacy hold', async () => {
      const envelope = holdItem({
        originRef: 'discord:123:456:document.md',
        sourceChannelId: null,
      });
      const resolved = await releaseRaw(envelope);
      expect(resolved.ok).toBe(true);
      expect(redeliveries).toHaveLength(1);
      expect(redeliveries[0].sourceChannelId).toBe('123');
      if (resolved.ok) {
        expect(resolved.message).toContain('re-delivered it into 123');
      }
    });

    it('retries the known legacy no-channel failure once and persists the delivery receipt', async () => {
      const envelope = holdItem({
        originRef: 'discord:123:456:document.md',
        sourceChannelId: null,
      });
      store.applyDecision({
        id: envelope.id,
        action: 'release_raw',
        actor: 'fleet-principal:owner',
        reason: 'original reviewed release',
        atMs: clock,
      });

      expect(service.listItems().items[0]?.redeliveryRetryAvailable).toBe(true);
      const begin = service.beginDecision({ id: envelope.id, action: 'release_raw' });
      if (!begin.ok) throw new Error('retry begin failed');
      const retried = await service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        confirmToken: begin.confirmToken,
        reason: 'complete the previously failed delivery',
      });

      expect(retried.ok).toBe(true);
      expect(redeliveries).toHaveLength(1);
      expect(redeliveries[0].sourceChannelId).toBe('123');
      expect(store.getById(envelope.id)?.redelivery).toMatchObject({
        delivered: true,
        channelId: '123',
        entryId: 4242,
      });
      expect(service.listItems().items[0]?.redeliveryRetryAvailable).toBe(false);
      expect(service.beginDecision({ id: envelope.id, action: 'release_raw' }))
        .toMatchObject({ ok: false, status: 409 });
    });

    it('re-delivers the safe representation when that action is chosen', async () => {
      const envelope = holdItem({ safeRepresentationText: 'Summary: a neutral description.' });
      const begin = service.beginDecision({ id: envelope.id, action: 'release_sanitized' });
      if (!begin.ok) throw new Error('begin failed');
      await service.resolveDecision({
        id: envelope.id,
        action: 'release_sanitized',
        confirmToken: begin.confirmToken,
        reason: 'summary is enough',
      });
      expect(redeliveries).toHaveLength(1);
      expect(redeliveries[0].action).toBe('release_sanitized');
      expect(redeliveries[0].content).toBe('Summary: a neutral description.');
      expect(redeliveries[0].envelope.state).toBe('human_released_sanitized');
    });

    it('never re-delivers a discarded item', async () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'discard' });
      if (!begin.ok) throw new Error('begin failed');
      await service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        confirmToken: begin.confirmToken,
        reason: 'genuinely hostile',
      });
      expect(redeliveries).toHaveLength(0);
    });

    it('records an undeliverable release without reversing it or throwing', async () => {
      redeliverResult = () => ({ delivered: false, reason: 'no source channel was recorded' });
      const envelope = holdItem();
      const resolved = await releaseRaw(envelope);
      // The release still applied; only the delivery is reported as not landing.
      expect(resolved.ok).toBe(true);
      expect(store.getById(envelope.id)?.status).toBe('released_raw');
      if (resolved.ok) {
        expect(resolved.message).toContain('re-delivery did not land');
      }
    });

    it('does not let a throwing delivery port reverse the applied release', async () => {
      redeliverResult = () => {
        throw new Error('session store unavailable');
      };
      const envelope = holdItem();
      const resolved = await releaseRaw(envelope);
      expect(resolved.ok).toBe(true);
      expect(store.getById(envelope.id)?.envelope.state).toBe('human_released');
      if (resolved.ok) {
        expect(resolved.message).toContain('re-delivery did not land');
      }
    });
  });

  describe('the flywheel (per-source policy updates)', () => {
    it('always-deny on a site origin adds the host to deniedSites via the settings path', async () => {
      const envelope = holdItem({ originRef: 'https://evil.example/post' });
      const begin = service.beginDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
      });
      if (!begin.ok) throw new Error('begin failed');
      expect(begin.summary).toContain("always-deny site 'evil.example'");

      const resolved = await service.resolveDecision({
        id: envelope.id,
        action: 'discard',
        sourceList: 'always_deny',
        confirmToken: begin.confirmToken,
        reason: 'hostile source',
      });
      expect(resolved.ok).toBe(true);
      expect(mutations).toEqual([{ action: 'add', list: 'deniedSites', pattern: 'evil.example' }]);
    });

    it('always-allow on a person origin adds the canonical contact id to trustedPeople', async () => {
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
      const resolved = await service.resolveDecision({
        id: envelope.id,
        action: 'release_raw',
        sourceList: 'always_allow',
        confirmToken: begin.confirmToken,
        reason: 'known-good sender',
      });
      expect(resolved.ok).toBe(true);
      expect(mutations).toEqual([{ action: 'add', list: 'trustedPeople', pattern: 'contact:alice' }]);
    });

    it('is idempotent when the pattern is already listed', async () => {
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
      const resolved = await service.resolveDecision({
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

    it('aborts the decision (item stays held) when the source-list write fails', async () => {
      service = createAdminIntakeQuarantineService({
        store,
        settingsService: {
          getIntakeSourceLists: () => lists,
          mutateIntakeSourceList: async () => ({ ok: false, message: 'contradiction with trustedSites' }),
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
      const resolved = await service.resolveDecision({
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
    it('writes an applying → applied intake_firewall event around every decision', async () => {
      const envelope = holdItem();
      const begin = service.beginDecision({ id: envelope.id, action: 'release_raw' });
      if (!begin.ok) throw new Error('begin failed');
      const resolved = await service.resolveDecision({
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

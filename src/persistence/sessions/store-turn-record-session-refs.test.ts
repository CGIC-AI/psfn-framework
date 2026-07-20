import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionEntry } from '../../core/session/types.js';
import { buildContinuityEntryMetadata } from '../../core/session/continuity-provenance.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { createTurnId } from '../../core/turns/id.js';
import { SessionStore } from './store.js';
import {
  REDACTED_MESSAGE_PLACEHOLDER,
  WITHHELD_WIRE_BODY_MARKER,
} from './turn-record-session-refs.js';
import {
  AdminSessionTurnObservabilityStore,
  buildPromptLoomData,
} from '../../operator/garden/services/session-turn-observability.js';
import type { AdminTurnSnapshotData } from '../../operator/garden/services/types.js';
import { EventBus } from '../../shared/event-bus.js';
import { createTurnRecordIntrospectionSource } from '../../faculties/introspection/source.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { CogSecForensicArchive } from '../../core/cogsec/forensic-archive.js';
import {
  resolveCogSecEventsPath,
  resolveCogSecForensicArchiveDir,
} from '../layout.js';

/** Persist a record with its verbatim inline recentEntries intact (no ref) — the
 * exact pre-9ree "old fat" on-disk shape — by bypassing the session-entry slim
 * that SessionStore.appendTurnRecord normally applies. */
function appendFatTurnRecord(store: SessionStore, record: TurnRecord): void {
  (store as unknown as {
    turnRecordStore: { appendTurnRecord(record: TurnRecord): void };
  }).turnRecordStore.appendTurnRecord(record);
}

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-9ree-'));
  dirs.push(dir);
  return dir;
}

function readTurnRecordFile(dir: string): string {
  const turnDir = join(dir, '_turn_records');
  const files = readdirSync(turnDir).filter(name => name.endsWith('.jsonl'));
  return files.map(name => readFileSync(join(turnDir, name), 'utf8')).join('\n');
}

function message(entry: SessionEntry): Record<string, unknown> {
  return { role: entry.role, content: entry.content, provenance: { sourceEntryIds: [entry.id] } };
}

function buildTurnRecord(
  channelId: string,
  recentEntries: SessionEntry[],
  messages: Array<Record<string, unknown>>,
): TurnRecord {
  const turnId = createTurnId();
  return {
    schemaVersion: 1,
    turnId,
    requestId: `req-${turnId}`,
    channelId,
    channelType: 'api',
    startedAt: 1,
    completedAt: 2,
    status: 'completed',
    userMessage: { role: 'user', content: 'x', timestamp: 1 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test/model' },
    provenanceRefs: [],
    observability: {
      stages: [],
      retrievals: [],
      snapshot: {
        turnId,
        requestId: `req-${turnId}`,
        channelId,
        capturedAt: 1,
        trustLevel: 'regular',
        sessionContext: {
          channelId,
          recentEntries,
          compactionSummaryTexts: [],
          focusKnowledgeTexts: [],
          continuityEntries: [],
          versionPointer: 'test/session',
        },
        plan: {
          schemaVersion: 1,
          blocks: [],
          variables: {},
          messages,
          toolDefinitions: [],
          cachePlan: { staticBoundary: 0, sessionStableBoundary: 0 },
          scope: {},
        },
      },
    },
  } as unknown as TurnRecord;
}

describe('SessionStore turn-record session-entry diet (psfn-framework-9ree)', () => {
  it('erases the verbatim recentEntries copy from disk and reconstructs it from L0 on read', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:diet';
    store.append({ channelId, role: 'user', content: 'first partner line', timestamp: 1_000 });
    store.append({ channelId, role: 'assistant', content: 'first companion line', timestamp: 2_000 });
    store.append({ channelId, role: 'user', content: 'second partner line', timestamp: 3_000 });
    const entries = store.getRecent(channelId, 10);
    expect(entries).toHaveLength(3);

    // No plan.messages here so the ONLY copy of the bodies is recentEntries;
    // proving they vanish from the turn-record file proves the dedup.
    const record = buildTurnRecord(channelId, entries, []);
    void store.appendTurnRecord(record);

    const persisted = readTurnRecordFile(dir);
    expect(persisted).toContain('recentEntriesRef');
    expect(persisted).not.toContain('first partner line');
    expect(persisted).not.toContain('first companion line');
    expect(persisted).not.toContain('second partner line');

    // On read: reconstructed transparently from the journal.
    const read = store.getRecentTurnRecords(channelId, 10);
    expect(read).toHaveLength(1);
    const ctx = (read[0]!.observability!.snapshot as unknown as { sessionContext: { recentEntries: SessionEntry[] } }).sessionContext;
    expect(ctx.recentEntries.map(e => e.content)).toEqual([
      'first partner line',
      'first companion line',
      'second partner line',
    ]);
    expect((ctx as unknown as Record<string, unknown>).recentEntriesRef).toBeUndefined();
  });

  it('never resurrects an entry that is gone from L0, and masks its rendered message', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:gone';
    store.append({ channelId, role: 'user', content: 'kept line', timestamp: 1_000 });
    const entries = store.getRecent(channelId, 10);
    // Reference a phantom entry (id absent from L0) carrying sensitive text.
    const phantom: SessionEntry = { id: 9_999, channelId, role: 'user', content: 'REDACTED SECRET', timestamp: 4_000 };
    const captured = [...entries, phantom];
    const record = buildTurnRecord(channelId, captured, captured.map(message));
    void store.appendTurnRecord(record);

    // recentEntries never carries the phantom body verbatim — only its id.
    const persisted = readTurnRecordFile(dir);
    expect(persisted).toContain('"recentEntriesRef"');
    expect(persisted).toContain('9999');

    const read = store.getRecentTurnRecords(channelId, 10);
    const snapshot = read[0]!.observability!.snapshot as unknown as {
      sessionContext: { recentEntries: SessionEntry[] };
      plan: { messages: Array<{ content: string }> };
    };
    // recentEntries drops the unresolvable phantom; the kept entry survives.
    expect(snapshot.sessionContext.recentEntries.map(e => e.content)).toEqual(['kept line']);
    // The rendered view masks the phantom-backed message and keeps the live one.
    expect(snapshot.plan.messages.map(m => m.content)).toEqual(['kept line', REDACTED_MESSAGE_PLACEHOLDER]);
    expect(JSON.stringify(read)).not.toContain('REDACTED SECRET');
  });

  // ── pre-9ree "old fat" record gating (bead psfn-framework-hgw3.10) ──────────

  it('redaction-gates a pre-9ree fat record: a since-tombstoned L0 entry surfaces the marker, never the captured plaintext', async () => {
    const dir = makeDir();
    const companionRoot = join(dir, 'companion-data');
    const store = new SessionStore(dir);
    const channelId = 'api:oldfat';

    const secretId = store.append({ channelId, role: 'user', content: 'my SECRET pre-9ree line', timestamp: 1_000 });
    store.append({ channelId, role: 'assistant', content: 'kept companion line', timestamp: 2_000 });
    const entries = store.getRecent(channelId, 10);

    // Persist the fat record verbatim (inline recentEntries, no ref).
    appendFatTurnRecord(store, buildTurnRecord(channelId, entries, entries.map(message)));

    // Proof it is genuinely fat: the plaintext IS on disk and there is no ref —
    // so an ungated read would resurrect it. That is the leak this gate closes.
    const persisted = readTurnRecordFile(dir);
    expect(persisted).not.toContain('recentEntriesRef');
    expect(persisted).toContain('my SECRET pre-9ree line');

    // CogSec-tombstone the secret L0 entry.
    const caseId = 'cogsec_20260715T000000Z_oldfat';
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot));
    const forensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot));
    eventStore.createEvent({
      caseId,
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: channelId,
      safeAgentSummary: 'sealed and removed from active cognition',
    });
    await store.applyCogSecTombstones({ channelId, caseId, eventStore, forensicArchive, messageIds: [secretId] });

    // Read back: recentEntries surfaces the marker, never the captured plaintext.
    const read = store.getRecentTurnRecords(channelId, 10);
    expect(read).toHaveLength(1);
    const ctx = (read[0]!.observability!.snapshot as unknown as {
      sessionContext: { recentEntries: SessionEntry[]; recentEntriesRef?: unknown };
    }).sessionContext;
    expect(ctx.recentEntries.map(e => e.content)).toEqual([
      `[CogSec redaction: ${caseId}]`,
      'kept companion line',
    ]);
    expect(ctx.recentEntriesRef).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain('my SECRET pre-9ree line');
  });

  it('heals a pre-9ree fat record whose inline L0 entry is now gone, never resurrecting its body', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:oldfat-gone';
    store.append({ channelId, role: 'user', content: 'live line', timestamp: 1_000 });
    const entries = store.getRecent(channelId, 10);
    // A captured entry whose id is absent from L0 (redacted-as-tombstone / rolled off).
    const phantom: SessionEntry = { id: 9_999, channelId, role: 'user', content: 'PHANTOM SECRET body', timestamp: 4_000 };

    appendFatTurnRecord(store, buildTurnRecord(channelId, [...entries, phantom], []));

    // Genuinely fat on disk: the phantom body is present verbatim (the leak).
    const persisted = readTurnRecordFile(dir);
    expect(persisted).not.toContain('recentEntriesRef');
    expect(persisted).toContain('PHANTOM SECRET body');

    const read = store.getRecentTurnRecords(channelId, 10);
    const ctx = (read[0]!.observability!.snapshot as unknown as {
      sessionContext: { recentEntries: SessionEntry[] };
    }).sessionContext;
    expect(ctx.recentEntries.map(e => e.content)).toEqual(['live line']);
    expect(JSON.stringify(read)).not.toContain('PHANTOM SECRET body');
  });
});

describe('SessionStore top-level turn-message CogSec gating (psfn-framework-sm9l)', () => {
  it('serves redaction notices through introspection, Garden buildTurnData, and every store read exit', async () => {
    const dir = makeDir();
    const companionRoot = join(dir, 'companion-data');
    const store = new SessionStore(dir);
    const channelId = 'discord:public-redaction';
    const partnerSecret = 'TOP_LEVEL_PARTNER_SECRET';
    const companionSecret = 'TOP_LEVEL_COMPANION_SECRET';
    const userEntryId = store.append({
      channelId,
      role: 'user',
      content: partnerSecret,
      timestamp: 1_000,
    });
    const assistantEntryId = store.append({
      channelId,
      role: 'assistant',
      content: companionSecret,
      timestamp: 2_000,
    });
    const entries = store.getRecent(channelId, 10);
    const record = buildTurnRecord(channelId, entries, entries.map(message));
    record.userMessage = {
      role: 'user',
      content: partnerSecret,
      timestamp: 1_000,
      sessionEntryId: userEntryId,
    };
    record.assistantMessage = {
      role: 'assistant',
      content: companionSecret,
      timestamp: 2_000,
      sessionEntryId: assistantEntryId,
    };
    const recordSnapshot = record.observability!.snapshot! as unknown as Record<string, unknown>;
    recordSnapshot.promptContext = {
      currentTurnInput: partnerSecret,
      response: { content: companionSecret },
    };
    record.auditPrivacy = {
      schemaVersion: 1,
      contentMode: 'verbatim_public',
      channelPrivacy: 'public',
      contentSensitivity: 'non_intimate',
      contentSensitivityActor: {
        kind: 'companion',
        turnId: record.turnId,
        requestId: record.requestId,
      },
      reason: 'explicit_public_non_dm',
    };
    await store.appendTurnRecord(record);

    const caseId = 'cogsec_20260719T000000Z_turn_messages';
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot));
    const forensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot));
    eventStore.createEvent({
      caseId,
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: channelId,
      safeAgentSummary: 'sealed and removed from active cognition',
    });
    await store.applyCogSecTombstones({
      channelId,
      caseId,
      eventStore,
      forensicArchive,
      messageIds: [userEntryId, assistantEntryId],
    });

    const recent = store.getRecentTurnRecords(channelId, 10);
    const found = store.findTurnRecord(channelId, record.turnId);
    const sourceRecent = store.getRecentSourceTurnRecords(channelId, 10);
    const sourceFound = store.findSourceTurnRecord(channelId, channelId, record.turnId);
    const uniqueSource = store.findUniqueSourceTurnRecord(channelId, record.turnId);
    for (const candidate of [
      recent[0],
      found,
      sourceRecent[0],
      sourceFound,
      uniqueSource,
    ]) {
      expect(candidate?.userMessage.content).toBe(REDACTED_MESSAGE_PLACEHOLDER);
      expect(candidate?.assistantMessage?.content).toBe(REDACTED_MESSAGE_PLACEHOLDER);
      expect(JSON.stringify(candidate)).not.toContain(partnerSecret);
      expect(JSON.stringify(candidate)).not.toContain(companionSecret);
    }

    const introspection = createTurnRecordIntrospectionSource({
      listRecentSessions: () => [{ sessionId: channelId, sourceChannelId: channelId }],
      getRecentTurnRecords: (sourceChannelId, limit, offset) => (
        store.getRecentSourceTurnRecords(sourceChannelId, limit, offset)
      ),
      isSessionRetiredOrQuarantined: () => false,
      isSourceTurnRecordEligible: (sourceChannelId, ownerSessionId, turnId) => (
        store.isSourceTurnRecordEligible(sourceChannelId, ownerSessionId, turnId)
      ),
    });
    const introspectionCandidates = introspection.listCandidates({
      allowedPublicChannelIds: [channelId],
      recentSessionLimit: 10,
      recentTurnLimit: 10,
      maxSourceChars: 1_000,
    });
    expect(JSON.stringify(introspectionCandidates)).not.toContain(partnerSecret);
    expect(JSON.stringify(introspectionCandidates)).not.toContain(companionSecret);
    expect(introspectionCandidates[0]).toMatchObject({
      publicStimulus: REDACTED_MESSAGE_PLACEHOLDER,
      actualReply: REDACTED_MESSAGE_PLACEHOLDER,
    });

    const garden = new AdminSessionTurnObservabilityStore({ eventBus: new EventBus() });
    const gardenTurn = garden.buildTurnData(recent[0]!);
    expect(gardenTurn.record.userMessage.content).toBe(REDACTED_MESSAGE_PLACEHOLDER);
    expect(gardenTurn.record.assistantMessage?.content).toBe(REDACTED_MESSAGE_PLACEHOLDER);
    expect(gardenTurn.promptLoom.memoryCapture.input.userMessage?.content)
      .toBe(REDACTED_MESSAGE_PLACEHOLDER);
    expect(gardenTurn.promptLoom.memoryCapture.input.assistantMessage?.content)
      .toBe(REDACTED_MESSAGE_PLACEHOLDER);
    expect(gardenTurn.promptLoom.memoryCapture.input.currentTurnInput)
      .toBe(REDACTED_MESSAGE_PLACEHOLDER);
    expect(gardenTurn.promptLoom.providerResult.renderedChatOutput)
      .toBe(REDACTED_MESSAGE_PLACEHOLDER);
    expect(JSON.stringify(gardenTurn)).not.toContain(partnerSecret);
    expect(JSON.stringify(gardenTurn)).not.toContain(companionSecret);
  });
});

// ── captured wire-body CogSec gating (bead psfn-framework-eb14) ────────────────

/** Build a turn record whose snapshot carries a captured provider wire body
 * (the shape 80f6 interns into `_shared/wirebodies`). The body embeds the
 * verbatim partner/companion lines the provider request actually shipped. */
function buildWireTurnRecord(
  channelId: string,
  recentEntries: SessionEntry[],
  messages: Array<Record<string, unknown>>,
  wireBody: unknown,
  options?: {
    /**
     * The current turn's own partner L0 entry id — persisted at
     * `userMessage.sessionEntryId`. Production EXCLUDES this entry from both
     * `recentEntries` and `plan.messages` (prompt-assembly throws if it leaks
     * into prior history), yet its plaintext IS the wire body's final user
     * message. Set this to reproduce the production shape where the tombstone
     * target is the current turn itself (bead psfn-framework-eb14, blocker 1).
     */
    currentTurnPartnerEntryId?: number;
    /** The wire body's final user message text (= the current partner line). */
    currentTurnInput?: string;
  },
): TurnRecord {
  const record = buildTurnRecord(channelId, recentEntries, messages);
  const snapshot = record.observability!.snapshot! as unknown as Record<string, unknown>;
  // Give the plan an (empty) blocks array so the Loom system-section derivation
  // has something to iterate; the raw-wire panel we assert on is independent.
  snapshot.plan = {
    schemaVersion: 1,
    messages,
    blocks: [],
    variables: {},
    toolDefinitions: [],
    cachePlan: { staticBoundary: 0, sessionStableBoundary: 0 },
    scope: {},
  };
  if (options?.currentTurnPartnerEntryId !== undefined) {
    (record.userMessage as { sessionEntryId?: number; content: string }).sessionEntryId
      = options.currentTurnPartnerEntryId;
    if (options.currentTurnInput !== undefined) {
      (record.userMessage as { content: string }).content = options.currentTurnInput;
    }
  }
  snapshot.promptContext = {
    currentTurnInput: options?.currentTurnInput ?? 'wire input',
    providerObservability: {
      routeKind: 'registered_model',
      requestedProvider: 'fixture',
      requestedModel: 'fixture',
      backendProvider: 'fixture',
      backendModel: 'fixture',
      backendApi: 'anthropic-messages',
      // transport null ⇒ Loom uses the recorded_snapshot branch (no full plan
      // serialization needed) while still surfacing capturedWirePayload.
      systemRole: {
        transport: null,
        supportsSystemRole: true,
        supportsDeveloperRole: false,
        usesOutOfBandSystemPrompt: false,
      },
      promptCaching: { configured: false, engaged: false },
      capturedWirePayload: {
        api: 'anthropic-messages',
        model: 'test/model',
        capturedAtMs: 1_700_000_000_000,
        byteLength: Buffer.byteLength(JSON.stringify(wireBody), 'utf8'),
        toolCount: 0,
        body: wireBody,
      },
    },
  };
  return record;
}

function capturedBody(record: TurnRecord): unknown {
  const snapshot = record.observability!.snapshot as unknown as {
    promptContext?: { providerObservability?: { capturedWirePayload?: { body?: unknown } } };
  };
  return snapshot.promptContext?.providerObservability?.capturedWirePayload?.body;
}

describe('SessionStore captured wire-body CogSec gating (psfn-framework-eb14)', () => {
  // HISTORY-redaction path: a PRIOR-turn partner entry (present in plan.messages
  // with provenance, the production shape for history) is tombstoned. This
  // exercises the plan.messages-suppression withhold key. The CURRENT-turn entry
  // path — the entry plan.messages structurally excludes — is covered by the
  // dedicated regression below (blocker 1); this test deliberately does NOT stand
  // in for it.
  it('withholds a captured wire body once a PRIOR-history partner L0 entry it embedded is tombstoned, across every read and the Loom', async () => {
    const dir = makeDir();
    const companionRoot = join(dir, 'companion-data');
    const store = new SessionStore(dir);
    const channelId = 'api:wire';

    const secretId = store.append({ channelId, role: 'user', content: 'my SECRET wire line', timestamp: 1_000 });
    store.append({ channelId, role: 'assistant', content: 'kept companion line', timestamp: 2_000 });
    const entries = store.getRecent(channelId, 10);

    // The captured provider request body embeds the verbatim conversation.
    const wireBody = {
      model: 'test/model',
      system: 'a static system prompt',
      messages: entries.map(entry => ({ role: entry.role, content: entry.content })),
    };
    const record = buildWireTurnRecord(channelId, entries, entries.map(message), wireBody);
    void store.appendTurnRecord(record);

    // Before any redaction: the raw body is served verbatim (the 80f6 contract).
    const before = store.getRecentTurnRecords(channelId, 10);
    expect(JSON.stringify(capturedBody(before[0]!))).toContain('my SECRET wire line');

    // CogSec-tombstone the partner L0 entry the body embedded.
    const caseId = 'cogsec_20260715T000000Z_wire';
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot));
    const forensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot));
    eventStore.createEvent({
      caseId,
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: channelId,
      safeAgentSummary: 'sealed and removed from active cognition',
    });
    await store.applyCogSecTombstones({ channelId, caseId, eventStore, forensicArchive, messageIds: [secretId] });

    // getRecentTurnRecords: the raw body is withheld — no verbatim plaintext.
    const read = store.getRecentTurnRecords(channelId, 10);
    expect(JSON.stringify(read)).not.toContain('my SECRET wire line');
    expect(capturedBody(read[0]!)).toMatchObject({ withheld: WITHHELD_WIRE_BODY_MARKER });
    // The summary attestation (api/model/byteLength/toolCount) survives.
    const summary = (read[0]!.observability!.snapshot as unknown as {
      promptContext: { providerObservability: { capturedWirePayload: Record<string, unknown> } };
    }).promptContext.providerObservability.capturedWirePayload;
    expect(summary.model).toBe('test/model');
    expect(summary.toolCount).toBe(0);

    // findTurnRecord: same gating.
    const found = store.findTurnRecord(channelId, record.turnId);
    expect(JSON.stringify(found)).not.toContain('my SECRET wire line');

    // Loom "Raw Wire Body" panel: served from the gated record → no plaintext.
    const loom = buildPromptLoomData(
      read[0]!,
      read[0]!.observability!.snapshot as unknown as AdminTurnSnapshotData,
    );
    expect(JSON.stringify(loom.providerWire.capturedWirePayload)).not.toContain('my SECRET wire line');
    expect(loom.providerWire.capturedWirePayload?.body).toMatchObject({ withheld: WITHHELD_WIRE_BODY_MARKER });
  });

  // ── blocker 1: the CURRENT turn's own partner entry ─────────────────────────
  // Production shape: the current-turn partner entry is EXCLUDED from both
  // recentEntries and plan.messages, yet its plaintext is the wire body's final
  // user message. Before the fix, tombstoning it left NO plan.messages provenance
  // signal, so the body served the redacted plaintext verbatim. The fix keys the
  // withhold on userMessage.sessionEntryId directly.
  it('withholds the wire body when the CURRENT turn\'s own partner entry is tombstoned, though it is absent from plan.messages', async () => {
    const dir = makeDir();
    const companionRoot = join(dir, 'companion-data');
    const store = new SessionStore(dir);
    const channelId = 'api:wire-current';

    // Prior history (stays live) precedes the current turn's own partner entry.
    store.append({ channelId, role: 'user', content: 'earlier partner line', timestamp: 1_000 });
    store.append({ channelId, role: 'assistant', content: 'earlier companion line', timestamp: 2_000 });
    const history = store.getRecent(channelId, 10);
    const currentId = store.append({ channelId, role: 'user', content: 'my SECRET current line', timestamp: 3_000 });
    const currentEntry = store.getRecent(channelId, 10).find(entry => entry.id === currentId)!;

    // recentEntries + plan.messages carry ONLY the history (production exclusion);
    // the wire body appends the current-turn partner text as its final message.
    const wireBody = {
      model: 'test/model',
      system: 'a static system prompt',
      messages: [...history, currentEntry].map(entry => ({ role: entry.role, content: entry.content })),
    };
    // Note: only the wire body (and the L0 journal) carry the secret here. The
    // turn record's frozen userMessage.content is a SEPARATE persistence surface
    // outside eb14's wire-body scope, so it is left at its default and the
    // assertions below target the wire body specifically.
    const record = buildWireTurnRecord(channelId, history, history.map(message), wireBody, {
      currentTurnPartnerEntryId: currentId,
    });
    void store.appendTurnRecord(record);

    // Before redaction: the current-turn line is served verbatim (80f6 contract).
    const before = store.getRecentTurnRecords(channelId, 10);
    expect(JSON.stringify(capturedBody(before[0]!))).toContain('my SECRET current line');

    // Tombstone the CURRENT turn's own partner entry — the entry plan.messages
    // structurally never carried.
    const caseId = 'cogsec_20260715T000000Z_current';
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot));
    const forensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot));
    eventStore.createEvent({
      caseId,
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: channelId,
      safeAgentSummary: 'sealed and removed from active cognition',
    });
    await store.applyCogSecTombstones({ channelId, caseId, eventStore, forensicArchive, messageIds: [currentId] });

    const read = store.getRecentTurnRecords(channelId, 10);
    // The history in plan.messages is untouched (its entries are still live) —
    // proving the plan.messages mask alone did NOT drive this withhold.
    const planMessages = (read[0]!.observability!.snapshot as unknown as {
      plan: { messages: Array<{ content: string }> };
    }).plan.messages;
    expect(planMessages.map(m => m.content)).toEqual(['earlier partner line', 'earlier companion line']);
    // The wire body is withheld across every read and the Loom — no plaintext.
    expect(JSON.stringify(read)).not.toContain('my SECRET current line');
    expect(capturedBody(read[0]!)).toMatchObject({ withheld: WITHHELD_WIRE_BODY_MARKER });

    const found = store.findTurnRecord(channelId, record.turnId);
    expect(JSON.stringify(found)).not.toContain('my SECRET current line');

    const loom = buildPromptLoomData(
      read[0]!,
      read[0]!.observability!.snapshot as unknown as AdminTurnSnapshotData,
    );
    expect(JSON.stringify(loom.providerWire.capturedWirePayload)).not.toContain('my SECRET current line');
    expect(loom.providerWire.capturedWirePayload?.body).toMatchObject({ withheld: WITHHELD_WIRE_BODY_MARKER });
  });

  // ── blocker 1: empty plan.messages must not skip the wire-body gate ──────────
  // Before the fix, gateRenderedViews early-returned when plan.messages was empty,
  // leaving a present wire body ungated. Here plan.messages is empty but the
  // recentEntries window (and the wire body) embed a partner entry that is later
  // tombstoned; the body must still be withheld.
  it('withholds a body with EMPTY plan.messages once a recentEntries window entry it embedded is tombstoned', async () => {
    const dir = makeDir();
    const companionRoot = join(dir, 'companion-data');
    const store = new SessionStore(dir);
    const channelId = 'api:wire-empty-plan';

    const secretId = store.append({ channelId, role: 'user', content: 'my SECRET windowed line', timestamp: 1_000 });
    const entries = store.getRecent(channelId, 10);
    // Empty plan.messages, but the recentEntries window + wire body carry the entry.
    const wireBody = { model: 'test/model', messages: entries.map(entry => ({ role: entry.role, content: entry.content })) };
    void store.appendTurnRecord(buildWireTurnRecord(channelId, entries, [], wireBody));

    // Before redaction: empty plan.messages, body served verbatim.
    const before = store.getRecentTurnRecords(channelId, 10);
    expect(JSON.stringify(capturedBody(before[0]!))).toContain('my SECRET windowed line');
    expect(JSON.stringify(before)).not.toContain(WITHHELD_WIRE_BODY_MARKER);

    const caseId = 'cogsec_20260715T000000Z_emptyplan';
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot));
    const forensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot));
    eventStore.createEvent({
      caseId,
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: channelId,
      safeAgentSummary: 'sealed and removed from active cognition',
    });
    await store.applyCogSecTombstones({ channelId, caseId, eventStore, forensicArchive, messageIds: [secretId] });

    const read = store.getRecentTurnRecords(channelId, 10);
    expect(JSON.stringify(read)).not.toContain('my SECRET windowed line');
    expect(capturedBody(read[0]!)).toMatchObject({ withheld: WITHHELD_WIRE_BODY_MARKER });
  });

  it('scrubs origin-redacted cross-channel content from body.system, continuity entries, and Loom projections', async () => {
    const dir = makeDir();
    const companionRoot = join(dir, 'companion-data');
    const store = new SessionStore(dir);
    const originChannelId = 'api:continuity-origin';
    const consumerChannelId = 'api:continuity-consumer';
    const secret = 'CROSS_CHANNEL_WIRE_SECRET';
    const timestamp = 1_700_000_000_000;
    const sourceEntryId = store.append({
      channelId: originChannelId,
      role: 'user',
      content: secret,
      authorId: 'partner-1',
      authorName: 'Partner',
      timestamp,
      channelVisibility: 'private',
    });
    store.append({
      channelId: consumerChannelId,
      role: 'user',
      content: 'current consumer turn',
      timestamp: timestamp + 1,
      channelVisibility: 'private',
    });
    const continuityEntry: SessionEntry = {
      id: 1,
      channelId: originChannelId,
      originChannelId,
      role: 'user',
      content: secret,
      authorId: 'partner-1',
      authorName: 'Partner',
      timestamp,
      channelVisibility: 'private',
      metadata: buildContinuityEntryMetadata({
        continuityUserId: 'partner-1',
        sourceChannelId: originChannelId,
        sourceVisibility: 'private',
        sourceRole: 'user',
        recordedAt: timestamp,
        sourceEntryId,
      }),
    };
    const wireBody = {
      model: 'test/model',
      system: `<cross_channel_continuity><text>${secret}</text></cross_channel_continuity>`,
      messages: [{ role: 'user', content: 'current consumer turn' }],
    };
    const record = buildWireTurnRecord(consumerChannelId, [], [], wireBody);
    const snapshot = record.observability!.snapshot! as unknown as Record<string, unknown>;
    snapshot.sessionContext = {
      channelId: consumerChannelId,
      recentEntries: [],
      compactionSummaryTexts: [],
      focusKnowledgeTexts: [],
      continuityEntries: [continuityEntry],
      versionPointer: 'test/continuity',
    };
    snapshot.plan = {
      schemaVersion: 1,
      messages: [],
      toolDefinitions: [],
      variables: {},
      cachePlan: { staticBoundary: 0, sessionStableBoundary: 0 },
      scope: {},
      blocks: [{
        id: 'session.continuity',
        layer: 'session',
        renderedText: `<cross_channel_continuity><text>${secret}</text></cross_channel_continuity>`,
      }],
    };
    const promptContext = snapshot.promptContext as {
      finalSystemSections?: unknown[];
    };
    promptContext.finalSystemSections = [{
      id: 'cross_channel_continuity',
      title: 'Cross-Channel Continuity',
      content: `<cross_channel_continuity><text>${secret}</text></cross_channel_continuity>`,
      charCount: secret.length,
      tokenCount: 1,
    }];
    await store.appendTurnRecord(record);

    const before = store.getRecentTurnRecords(consumerChannelId, 10);
    expect(JSON.stringify(before)).toContain(secret);

    const caseId = 'cogsec_20260719T000000Z_cross_channel';
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot));
    const forensicArchive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot));
    eventStore.createEvent({
      caseId,
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: originChannelId,
      safeAgentSummary: 'sealed and removed from active cognition',
    });
    await store.applyCogSecTombstones({
      channelId: originChannelId,
      caseId,
      eventStore,
      forensicArchive,
      messageIds: [sourceEntryId],
    });

    const recent = store.getRecentTurnRecords(consumerChannelId, 10);
    const found = store.findTurnRecord(consumerChannelId, record.turnId);
    const sourceRecent = store.getRecentSourceTurnRecords(consumerChannelId, 10);
    for (const candidate of [recent[0], found, sourceRecent[0]]) {
      expect(JSON.stringify(candidate)).not.toContain(secret);
      const candidateSnapshot = candidate?.observability?.snapshot as unknown as {
        sessionContext: { continuityEntries: SessionEntry[] };
      };
      expect(candidateSnapshot.sessionContext.continuityEntries[0]?.content)
        .toBe(REDACTED_MESSAGE_PLACEHOLDER);
      expect(capturedBody(candidate!)).toMatchObject({
        withheld: WITHHELD_WIRE_BODY_MARKER,
      });
    }

    const gardenStore = new AdminSessionTurnObservabilityStore({ eventBus: new EventBus() });
    const gardenTurn = gardenStore.buildTurnData(recent[0]!);
    const loom = buildPromptLoomData(
      recent[0]!,
      recent[0]!.observability!.snapshot as unknown as AdminTurnSnapshotData,
    );
    expect(JSON.stringify(gardenTurn)).not.toContain(secret);
    expect(JSON.stringify(loom)).not.toContain(secret);
    expect(loom.providerWire.capturedWirePayload?.body).toMatchObject({
      withheld: WITHHELD_WIRE_BODY_MARKER,
    });
  });

  it('serves the captured wire body verbatim while all embedded L0 entries remain live', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:wire-live';
    store.append({ channelId, role: 'user', content: 'ordinary partner line', timestamp: 1_000 });
    const entries = store.getRecent(channelId, 10);
    const wireBody = { model: 'test/model', messages: entries.map(e => ({ role: e.role, content: e.content })) };
    void store.appendTurnRecord(buildWireTurnRecord(channelId, entries, entries.map(message), wireBody));

    const read = store.getRecentTurnRecords(channelId, 10);
    // No redaction ⇒ byte-identical body, no withhold marker.
    expect(JSON.stringify(capturedBody(read[0]!))).toContain('ordinary partner line');
    expect(JSON.stringify(read)).not.toContain(WITHHELD_WIRE_BODY_MARKER);
  });
});

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnId } from '../../core/turns/id.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import { buildSessionHmacKeyring } from '../journals/journal-utils.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import type { SessionHmacKeyring } from '../journals/journal/types.js';
import { SessionStore } from './store.js';
import { primeTurnTombstoneAuthorityOffPrimary } from './store/startup-tombstone-authority.js';

const dirs: string[] = [];
const OWNER_COUNT = 3;
/** Declared startup budget for warm SessionStore construction over large L0 journals. */
const CONSTRUCTION_BUDGET_MS = 1_500;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function makeKeyring(label: string): SessionHmacKeyring {
  const keyring = buildSessionHmacKeyring({
    serializedKeys: `v1:${label}-startup-priming-key`,
    activeVersion: 'v1',
  });
  if (!keyring) throw new Error('Expected a test keyring');
  return keyring;
}

function listJournalPaths(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => join(dir, name));
}

function turnMetadata(turnId: TurnID, role: 'user' | 'assistant'): string {
  return JSON.stringify({
    turn: { schemaVersion: 1, turnId, requestId: `req-${turnId}`, role },
  });
}

interface PrimingFixture {
  dir: string;
  keyring: SessionHmacKeyring;
  channelIds: string[];
  redactedTurnIds: TurnID[];
  totalBytes: number;
}

/**
 * Several owners, each with a multi-hundred-kilobyte L0 journal and one signed
 * redaction. The old constructor parsed every one of these bytes synchronously.
 */
async function createPrimingFixture(): Promise<PrimingFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-session-startup-priming-'));
  dirs.push(dir);
  const keyring = makeKeyring('multi-owner');
  const writer = new SessionStore(dir, { integrityKeyring: keyring });
  const channelIds: string[] = [];
  const redactedTurnIds: TurnID[] = [];
  const padding = 'p'.repeat(32 * 1024);

  for (let owner = 0; owner < OWNER_COUNT; owner += 1) {
    const channelId = `api:startup-priming-${String(owner)}`;
    channelIds.push(channelId);
    let redactedTurnId: TurnID | null = null;
    for (let turn = 0; turn < 6; turn += 1) {
      const turnId = createTurnId(1_700_000_000_000 + owner * 1_000 + turn);
      if (turn === 1) redactedTurnId = turnId;
      writer.append({
        channelId,
        role: 'user',
        content: `owner-${String(owner)}-turn-${String(turn)}-user ${padding}`,
        timestamp: 1_000 + turn * 10,
        metadata: turnMetadata(turnId, 'user'),
      });
      writer.append({
        channelId,
        role: 'assistant',
        content: `owner-${String(owner)}-turn-${String(turn)}-assistant ${padding}`,
        timestamp: 1_005 + turn * 10,
        metadata: turnMetadata(turnId, 'assistant'),
      });
    }
    if (!redactedTurnId) throw new Error('Expected a redaction target');
    await writer.redactTurn(channelId, redactedTurnId, {
      actor: 'admin:test',
      reason: 'privacy request',
      timestamp: 2_000,
    });
    redactedTurnIds.push(redactedTurnId);
  }

  const totalBytes = listJournalPaths(dir)
    .reduce((sum, filePath) => sum + statSync(filePath).size, 0);
  return { dir, keyring, channelIds, redactedTurnIds, totalBytes };
}

describe('SessionStore startup L0 tombstone priming (psfn-framework-5jx2v)', () => {
  it('constructs without parsing or matching-scanning any L0 journal on the primary thread', async () => {
    const fixture = await createPrimingFixture();
    const archivePort = createFilesystemSessionArchivePort();
    const scanMetadata = vi.spyOn(archivePort, 'scanJournalFileMetadata');
    const matchingScan = vi.spyOn(archivePort, 'readJournalMatchingEntriesBackward');
    const readJournalFile = vi.spyOn(archivePort, 'readJournalFile');

    expect(fixture.totalBytes).toBeGreaterThan(1024 * 1024);
    const startedAt = Date.now();
    const store = new SessionStore(fixture.dir, {
      integrityKeyring: fixture.keyring,
      sessionArchivePort: archivePort,
    });
    const elapsedMs = Date.now() - startedAt;

    // Every one of these was O(total L0 bytes) on the primary event loop before
    // this bead; the warm channel index now carries construction on its own.
    expect(scanMetadata).not.toHaveBeenCalled();
    expect(matchingScan).not.toHaveBeenCalled();
    expect(readJournalFile).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(CONSTRUCTION_BUDGET_MS);
    expect(store).toBeInstanceOf(SessionStore);
  });

  it('verifies canonical authority off-primary while startup work keeps advancing', async () => {
    const fixture = await createPrimingFixture();
    expect(fixture.totalBytes).toBeGreaterThan(1024 * 1024);
    const store = new SessionStore(fixture.dir, { integrityKeyring: fixture.keyring });

    let heartbeats = 0;
    const settled: string[] = [];
    const timer = setInterval(() => { heartbeats += 1; }, 1);
    let report;
    try {
      report = await store.primeTurnTombstoneAuthority({
        onOwnerSettled: (sessionId) => { settled.push(sessionId); },
      });
    } finally {
      clearInterval(timer);
    }

    expect(report.considered).toBe(OWNER_COUNT);
    expect(report.primed).toBe(OWNER_COUNT);
    expect(report.deferred).toEqual([]);
    expect(settled).toHaveLength(OWNER_COUNT);
    expect(heartbeats).toBeGreaterThan(0);
    // The scan bytes were read by the forked worker, never on the primary heap.
    expect(report.bytesReadOffPrimary).toBeGreaterThan(0);

    // A second pass finds every owner current, proving the cache was populated
    // at the exact archive generation rather than left empty.
    const second = await store.primeTurnTombstoneAuthority();
    expect(second.alreadyCurrent).toBe(OWNER_COUNT);
    expect(second.primed).toBe(0);
  }, 60_000);

  it('keeps the signed redaction exact after off-primary priming', async () => {
    const fixture = await createPrimingFixture();
    const store = new SessionStore(fixture.dir, { integrityKeyring: fixture.keyring });
    await store.primeTurnTombstoneAuthority();

    for (const channelId of fixture.channelIds) {
      const entries = store.getRecent(channelId, 100);
      expect(entries).not.toHaveLength(0);
      // Ten messages survive; the redacted turn's two messages stay hidden.
      expect(entries).toHaveLength(10);
      expect(entries.some(entry => entry.content.includes('-turn-1-'))).toBe(false);
    }
  }, 60_000);

  it('defers an owner whose archive disappears instead of caching an empty authority', async () => {
    const fixture = await createPrimingFixture();
    const store = new SessionStore(fixture.dir, { integrityKeyring: fixture.keyring });
    const filePaths = listJournalPaths(fixture.dir);
    expect(filePaths.length).toBeGreaterThan(0);
    rmSync(filePaths[0]!, { force: true });

    const report = await store.primeTurnTombstoneAuthority();
    // The owner whose archive vanished is never cached as tombstone-free; it is
    // simply absent, so the lazy resolver rebuilds it fail-closed on demand.
    expect(report.primed).toBeLessThan(OWNER_COUNT);
  }, 60_000);

  it('re-primes evicted owners, proving retained authority owners are bounded', async () => {
    const fixture = await createPrimingFixture();
    const store = new SessionStore(fixture.dir, {
      integrityKeyring: fixture.keyring,
      turnTombstoneAuthorityOwners: 1,
    });
    const first = await store.primeTurnTombstoneAuthority();
    expect(first.primed).toBe(OWNER_COUNT);

    // The unbounded store reports every owner already current on a second pass
    // (asserted above). Under a one-owner bound each newly primed owner evicts
    // the previous one, so nothing survives to the next pass: retention is
    // bounded by the declared limit, not by session count.
    const second = await store.primeTurnTombstoneAuthority();
    expect(second.alreadyCurrent).toBe(0);
    expect(second.primed).toBe(OWNER_COUNT);
  }, 60_000);
});

describe('off-primary tombstone authority fail-closed cases (psfn-framework-5jx2v)', () => {
  const candidate = {
    sessionId: 'session-a',
    channelId: 'api:session-a',
    filePaths: ['/nonexistent/session-a.jsonl'],
    baselineTurnTombstoneIds: [],
  };

  it('defers an owner whose archive chain cannot be fingerprinted', async () => {
    const remember = vi.fn();
    const report = await primeTurnTombstoneAuthorityOffPrimary({
      candidates: [candidate],
      context: {
        openArchive: () => ({}) as never,
        fingerprintArchiveChain: () => null,
        verifyAndNormalizeEntry: entry => ({ entry, verified: true }),
      },
      limits: {
        maxActionBytes: 1_024,
        maxActions: 8,
        maxResultBytes: 4_096,
        maxRowBytes: 65_536,
        maxTombstones: 8,
        scanChunkBytes: 4_096,
      },
      isCurrent: () => false,
      remember,
    });
    expect(remember).not.toHaveBeenCalled();
    expect(report.primed).toBe(0);
    expect(report.deferred).toEqual([{ sessionId: 'session-a', reason: 'ENOENT' }]);
  });

  it('never caches an owner whose worker scan fails', async () => {
    const remember = vi.fn();
    const report = await primeTurnTombstoneAuthorityOffPrimary({
      candidates: [candidate],
      context: {
        openArchive: () => ({}) as never,
        // A stable fingerprint forces the worker scan, which fails on the
        // missing path: the owner must be deferred, not cached as empty.
        fingerprintArchiveChain: () => 'fingerprint-a',
        verifyAndNormalizeEntry: entry => ({ entry, verified: true }),
      },
      limits: {
        maxActionBytes: 1_024,
        maxActions: 8,
        maxResultBytes: 4_096,
        maxRowBytes: 65_536,
        maxTombstones: 8,
        scanChunkBytes: 4_096,
      },
      isCurrent: () => false,
      remember,
    });
    expect(remember).not.toHaveBeenCalled();
    expect(report.primed).toBe(0);
    expect(report.deferred).toHaveLength(1);
  }, 30_000);
});

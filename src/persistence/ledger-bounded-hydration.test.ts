import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileOutreachOutboxStore,
  openFileOutreachOutboxStore,
} from '../core/intention/outreach-outbox.js';
import { ReflectionJournalStore } from './journals/reflection-journal.js';
import {
  readRunChargeRollingWindowFromLedger,
  RunChargeLedger,
} from '../shared/telemetry/charge-ledger.js';

const tempRoots: string[] = [];
const NOW_MS = 1_800_000_000_000;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-ledger-bounded-'));
  tempRoots.push(dir);
  return dir;
}

/**
 * Count timer callbacks that fire while `run` is in flight. The previous
 * whole-file hydration ran to completion inside one synchronous call, so this
 * count was necessarily zero.
 */
async function measure<T>(run: () => Promise<T>): Promise<{ heartbeats: number; value: T }> {
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats += 1; }, 1);
  try {
    const value = await run();
    return { heartbeats, value };
  } finally {
    clearInterval(timer);
  }
}

function writeChargeLedger(path: string, rows: number): number {
  let expectedSocial = 0;
  const padding = 'p'.repeat(1_024);
  for (let index = 0; index < rows; index += 1) {
    const amount = 1;
    expectedSocial += amount;
    const eventId = randomUUID();
    appendFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      recordType: 'charge_event',
      eventId,
      recordedAtMs: NOW_MS - 1_000,
      event: {
        eventId,
        timestampMs: NOW_MS - 60_000,
        lane: 'companion_social',
        surface: 'companionSocialContinuation',
        amount,
        quota: 10_000,
        spentAfter: expectedSocial,
        remainingAfter: 10_000 - expectedSocial,
        lineage: { runId: 'run-a', rootRunId: 'run-a' },
        requestId: `request-${String(index)}`,
        turnId: `turn-${String(index)}`,
        callType: 'chat',
        purpose: padding,
        details: { provider: 'openai', model: 'gpt-test-1', modality: 'text' },
      },
    })}\n`, 'utf-8');
  }
  return expectedSocial;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('bounded ledger hydration surfaces (psfn-framework-z3e2x)', () => {
  it('keeps the ICP charge decision exact while letting timers advance', async () => {
    const path = join(makeTempDir(), 'charge-ledger.jsonl');
    const expectedSocial = writeChargeLedger(path, 3_000);
    expect(statSync(path).size).toBeGreaterThan(3 * 1024 * 1024);

    const { heartbeats, value } = await measure(
      () => readRunChargeRollingWindowFromLedger(path, NOW_MS, { ledgerReadYieldRows: 32 }),
    );
    expect(value.spentByLane.companion_social).toBe(expectedSocial);
    expect(value.entryCount).toBe(3_000);
    expect(heartbeats).toBeGreaterThan(0);
  });

  it('streams RunChargeLedger startup hydration without losing an entry', async () => {
    const path = join(makeTempDir(), 'charge-ledger.jsonl');
    writeChargeLedger(path, 3_000);
    const { heartbeats, value } = await measure(
      () => RunChargeLedger.open(path, null, {
        now: () => NOW_MS,
        readLimitSettings: { ledgerReadYieldRows: 32 },
      }),
    );
    expect(heartbeats).toBeGreaterThan(0);
    // Byte-for-byte identical to the synchronous hydration the constructor
    // still performs: streaming changes when rows are read, never which rows.
    const synchronous = new RunChargeLedger(path, null, { now: () => NOW_MS });
    expect(value.listEntries({ limit: 10_000 }))
      .toEqual(synchronous.listEntries({ limit: 10_000 }));
    expect(value.getData({ limit: 1 }).aggregates)
      .toEqual(synchronous.getData({ limit: 1 }).aggregates);
    synchronous.close();
    value.close();
  });

  it('preserves outreach outbox restart semantics across bounded hydration', async () => {
    const path = join(makeTempDir(), 'outreach-outbox.jsonl');
    const seed = createFileOutreachOutboxStore(path);
    for (let index = 0; index < 2_000; index += 1) {
      const dedupeKey = `dedupe-${String(index % 500)}`;
      seed.append({
        phase: index % 4 === 3 ? 'sent' : 'queued',
        actionId: `action-${String(index)}`,
        dedupeKey,
        channelId: 'primary-dm',
        channelType: 'discord',
        sourceMessageId: `msg-${String(index)}`,
        contentHash: `hash-${String(index)}`,
        contentLength: 12,
        recordedAt: NOW_MS + index,
        metadata: { padding: 'q'.repeat(512) },
      });
    }
    expect(statSync(path).size).toBeGreaterThan(1024 * 1024);

    const { heartbeats, value: streamed } = await measure(
      () => openFileOutreachOutboxStore(path, { readLimitSettings: { ledgerReadYieldRows: 32 } }),
    );
    expect(heartbeats).toBeGreaterThan(0);
    const synchronous = createFileOutreachOutboxStore(path);
    for (let index = 0; index < 500; index += 1) {
      const dedupeKey = `dedupe-${String(index)}`;
      expect(streamed.hasTerminal(dedupeKey)).toBe(synchronous.hasTerminal(dedupeKey));
      expect(streamed.getLatest(dedupeKey)).toEqual(synchronous.getLatest(dedupeKey));
    }
    expect(streamed.listRecent(25)).toEqual(synchronous.listRecent(25));
  });

  it('returns exactly the previously sorted reflection window from a bounded scan', () => {
    const path = join(makeTempDir(), 'reflection-journal.jsonl');
    const store = new ReflectionJournalStore(path);
    const padding = 'r'.repeat(1_024);
    const created: string[] = [];
    for (let index = 0; index < 1_500; index += 1) {
      // Deliberately non-monotonic createdAt: file order is not journal order,
      // so a tail-only read would return the wrong window.
      const createdAt = new Date(NOW_MS + ((index * 7_919) % 1_500) * 1_000).toISOString();
      created.push(createdAt);
      store.append({
        templateId: 'experiential-review',
        templateName: 'Experiential Review',
        prompt: padding,
        reflection: `reflection-${String(index)}`,
        channelId: 'internal:reflection',
        mode: 'agent',
        createdAt,
      });
    }
    expect(statSync(path).size).toBeGreaterThan(1024 * 1024);

    const recent = store.listRecent({ limit: 5 });
    const expectedNewest = [...created].sort((left, right) => Date.parse(right) - Date.parse(left));
    expect(recent).toHaveLength(5);
    expect(recent[0]?.createdAt).toBe(expectedNewest[0]);
    expect(recent.map(entry => entry.createdAt)).toEqual(
      [...recent].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .map(entry => entry.createdAt),
    );
  });
});

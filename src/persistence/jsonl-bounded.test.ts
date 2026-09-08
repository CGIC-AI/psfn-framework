import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJsonLinesReadStats,
  resolveJsonLinesReadLimits,
  streamJsonLines,
  streamJsonLinesSync,
} from './jsonl.js';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-jsonl-bounded-'));
  tempRoots.push(dir);
  return dir;
}

/** Write a ledger whose byte size is comfortably above one megabyte. */
function writeLargeLedger(path: string, rows: number, padBytes: number): void {
  const padding = 'x'.repeat(padBytes);
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    lines.push(JSON.stringify({ index, padding }));
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('bounded append-only JSONL hydration (psfn-framework-z3e2x)', () => {
  it('lets primary timers advance while streaming a multi-megabyte ledger', async () => {
    const path = join(makeTempDir(), 'large.jsonl');
    writeLargeLedger(path, 4_000, 2_048);
    expect(statSync(path).size).toBeGreaterThan(4 * 1024 * 1024);

    let heartbeats = 0;
    const timer = setInterval(() => { heartbeats += 1; }, 1);
    const stats = createJsonLinesReadStats();
    let scanned = 0;
    try {
      const result = await streamJsonLines(
        path,
        resolveJsonLinesReadLimits({ ledgerReadChunkBytes: 65_536, ledgerReadYieldRows: 16 }),
        () => { scanned += 1; },
        { stats },
      );
      expect(result.endOfSnapshot).toBe(true);
    } finally {
      clearInterval(timer);
    }

    expect(scanned).toBe(4_000);
    // Would be zero on the previous readFileSync + split hydration: a
    // synchronous whole-file read cannot let a timer fire.
    expect(heartbeats).toBeGreaterThan(0);
    expect(stats.eventLoopYields).toBeGreaterThan(0);
    // Retained physical-row bytes stay near one row, not the whole file.
    expect(stats.peakRowBytes).toBeLessThan(64 * 1024);
    expect(stats.bytesRead).toBe(statSync(path).size);
  });

  it('fails closed instead of retaining a row above the byte budget', async () => {
    const path = join(makeTempDir(), 'oversized.jsonl');
    writeFileSync(path, `${JSON.stringify({ padding: 'y'.repeat(400_000) })}\n`, 'utf-8');
    await expect(streamJsonLines(
      path,
      { chunkBytes: 4_096, maxRowBytes: 8_192, yieldRows: 8 },
      () => undefined,
    )).rejects.toMatchObject({ code: 'EOVERFLOW' });
  });

  it('fails closed when the append-only snapshot is truncated mid-scan', async () => {
    const path = join(makeTempDir(), 'truncated.jsonl');
    writeLargeLedger(path, 500, 1_024);
    const original = statSync(path).size;
    await expect(streamJsonLines(
      path,
      { chunkBytes: 4_096, maxRowBytes: 65_536, yieldRows: 1 },
      (_parsed, context) => {
        if (context.line === 10) truncateSync(path, Math.floor(original / 4));
      },
    )).rejects.toMatchObject({ code: 'ESTALE' });
  });

  it('fails closed on a malformed row unless the caller supplies a sink', () => {
    const path = join(makeTempDir(), 'malformed.jsonl');
    writeFileSync(path, '{"ok":1}\nnot-json\n', 'utf-8');
    const limits = { chunkBytes: 4_096, maxRowBytes: 65_536, yieldRows: 8 };
    expect(() => streamJsonLinesSync(path, limits, () => undefined)).toThrow();

    const skipped: number[] = [];
    const seen: unknown[] = [];
    streamJsonLinesSync(path, limits, parsed => { seen.push(parsed); }, {
      onParseError: context => { skipped.push(context.line); },
    });
    expect(seen).toEqual([{ ok: 1 }]);
    expect(skipped).toEqual([2]);
  });

  it('returns an explicit continuation cursor that resumes without re-reading', async () => {
    const path = join(makeTempDir(), 'cursor.jsonl');
    writeFileSync(path, [0, 1, 2, 3, 4].map(index => JSON.stringify({ index })).join('\n') + '\n', 'utf-8');
    const limits = { chunkBytes: 4_096, maxRowBytes: 65_536, yieldRows: 8 };
    const first: number[] = [];
    const head = await streamJsonLines(path, limits, (parsed) => {
      first.push((parsed as { index: number }).index);
      return first.length === 2;
    });
    expect(first).toEqual([0, 1]);
    expect(head.stopped).toBe(true);

    const rest: number[] = [];
    const tail = await streamJsonLines(path, limits, (parsed) => {
      rest.push((parsed as { index: number }).index);
    }, { startOffsetBytes: head.nextOffsetBytes });
    expect(rest).toEqual([2, 3, 4]);
    expect(tail.endOfSnapshot).toBe(true);
  });

  it('reassembles rows that straddle chunk boundaries', () => {
    const path = join(makeTempDir(), 'straddle.jsonl');
    const rows = [
      { id: 'a', text: 'z'.repeat(3_000) },
      { id: 'b', text: 'é'.repeat(2_000) },
      { id: 'c', text: 'w'.repeat(5_000) },
    ];
    writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf-8');
    const seen: unknown[] = [];
    streamJsonLinesSync(
      path,
      { chunkBytes: 512, maxRowBytes: 65_536, yieldRows: 4 },
      parsed => { seen.push(parsed); },
    );
    expect(seen).toEqual(rows);
  });

  it('rejects an unusable read budget rather than silently clamping it', () => {
    expect(() => resolveJsonLinesReadLimits({ ledgerReadChunkBytes: 0 }))
      .toThrow(/positive safe integer/);
    expect(() => resolveJsonLinesReadLimits({ ledgerReadMaxRowBytes: 1_024 }))
      .toThrow(/at least chunkBytes/);
  });
});

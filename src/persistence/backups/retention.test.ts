import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { applyTieredRetention, type TieredRetentionOptions } from './retention.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

/** Creates a fresh backup root populated with the given directory names. */
function makeBackupRoot(dirNames: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'psfn-retention-'));
  roots.push(root);
  for (const name of dirNames) {
    mkdirSync(join(root, name), { recursive: true });
  }
  return root;
}

/** Returns the kept directory basenames, sorted ascending for stable assertions. */
function keptNames(root: string, options: TieredRetentionOptions): {
  kept: string[];
  pruned: string[];
  dailyCount: number;
  weeklyCount: number;
  monthlyCount: number;
} {
  const result = applyTieredRetention(root, options);
  return {
    kept: result.keptBackupDirs.map(p => basename(p)).sort((a, b) => a.localeCompare(b)),
    pruned: result.prunedBackupDirs.map(p => basename(p)).sort((a, b) => a.localeCompare(b)),
    dailyCount: result.dailyCount,
    weeklyCount: result.weeklyCount,
    monthlyCount: result.monthlyCount,
  };
}

describe('applyTieredRetention daily tier', () => {
  it('keeps the newest backup per UTC calendar day, up to maxDailyBackups', () => {
    // Two backups per day across five days; daily tier keeps the newest three days.
    const root = makeBackupRoot([
      '20260301T010000000Z', '20260301T020000000Z',
      '20260302T010000000Z', '20260302T020000000Z',
      '20260303T010000000Z', '20260303T020000000Z',
      '20260304T010000000Z', '20260304T020000000Z',
      '20260305T010000000Z', '20260305T020000000Z',
    ]);

    const { kept, dailyCount } = keptNames(root, {
      maxRotatingBackups: 0,
      maxDailyBackups: 3,
      maxWeeklyBackups: 0,
      maxMonthlyBackups: 0,
    });

    expect(dailyCount).toBe(3);
    // Newest-per-day for the three most recent days only.
    expect(kept).toEqual([
      '20260303T020000000Z',
      '20260304T020000000Z',
      '20260305T020000000Z',
    ]);
  });

  it('does not consume a daily slot for a directory already protected by monthly/weekly', () => {
    // 2026-03-12 is the monthly winner; the daily tier must skip it and still
    // protect two fresh daily days below it rather than counting the shared dir.
    const root = makeBackupRoot([
      '20260115T010000000Z', // older month — pruned
      '20260310T010000000Z',
      '20260311T010000000Z',
      '20260312T010000000Z', // newest of newest month
    ]);

    const { kept, pruned, dailyCount, monthlyCount } = keptNames(root, {
      maxRotatingBackups: 0,
      maxDailyBackups: 2,
      maxWeeklyBackups: 0,
      maxMonthlyBackups: 1,
    });

    expect(monthlyCount).toBe(1);
    // Two NEW daily slots (03-11, 03-10) — the monthly-kept 03-12 did not consume one.
    expect(dailyCount).toBe(2);
    expect(kept).toEqual([
      '20260310T010000000Z',
      '20260311T010000000Z',
      '20260312T010000000Z',
    ]);
    expect(pruned).toEqual(['20260115T010000000Z']);
  });

  it('disables the daily tier when maxDailyBackups is zero', () => {
    const root = makeBackupRoot([
      '20260301T010000000Z',
      '20260302T010000000Z',
      '20260303T010000000Z',
    ]);

    // All tiers zero: only the fail-closed newest-survives floor applies.
    const { kept, dailyCount, weeklyCount, monthlyCount } = keptNames(root, {
      maxRotatingBackups: 0,
      maxDailyBackups: 0,
      maxWeeklyBackups: 0,
      maxMonthlyBackups: 0,
    });

    expect(dailyCount).toBe(0);
    expect(weeklyCount).toBe(0);
    expect(monthlyCount).toBe(0);
    expect(kept).toEqual(['20260303T010000000Z']);

    // Daily zero with rotating active: rotating keeps the newest N, daily stays 0.
    // Fresh root — the call above prunes dirs from disk.
    const rotatingRoot = makeBackupRoot([
      '20260301T010000000Z',
      '20260302T010000000Z',
      '20260303T010000000Z',
    ]);
    const rotatingResult = keptNames(rotatingRoot, {
      maxRotatingBackups: 2,
      maxDailyBackups: 0,
      maxWeeklyBackups: 0,
      maxMonthlyBackups: 0,
    });
    expect(rotatingResult.dailyCount).toBe(0);
    expect(rotatingResult.kept).toEqual([
      '20260302T010000000Z',
      '20260303T010000000Z',
    ]);
  });

  it('always keeps the newest backup under every tier-count combination (fail-closed invariant)', () => {
    const dirNames = [
      '20260101T010000000Z',
      '20260115T010000000Z',
      '20260210T010000000Z',
      '20260315T010000000Z',
      '20260316T010000000Z',
      '20260317T010000000Z',
    ];
    const newest = '20260317T010000000Z';
    const counts = [0, 1, 4];

    for (const maxRotatingBackups of counts) {
      for (const maxDailyBackups of counts) {
        for (const maxWeeklyBackups of counts) {
          for (const maxMonthlyBackups of counts) {
            const root = makeBackupRoot(dirNames);
            const { kept } = keptNames(root, {
              maxRotatingBackups,
              maxDailyBackups,
              maxWeeklyBackups,
              maxMonthlyBackups,
            });
            expect(kept).toContain(newest);
          }
        }
      }
    }
  });

  it('composes daily, weekly, and monthly tiers additively', () => {
    // Spread across months, weeks, and days so each tier claims distinct dirs.
    const root = makeBackupRoot([
      '20251201T010000000Z', // Dec 2025 — monthly only
      '20260105T010000000Z', // early Jan — monthly winner for Jan is later
      '20260131T010000000Z', // Jan 31 — monthly winner (newest of Jan)
      '20260209T010000000Z', // Feb, distinct week
      '20260216T010000000Z', // Feb, distinct week
      '20260223T010000000Z', // Feb, distinct week
      '20260301T010000000Z', // Mar day
      '20260302T010000000Z', // Mar day
      '20260303T010000000Z', // Mar day (newest overall)
    ]);

    const result = applyTieredRetention(root, {
      maxRotatingBackups: 0,
      maxDailyBackups: 2,
      maxWeeklyBackups: 2,
      maxMonthlyBackups: 2,
    });

    expect(result.monthlyCount).toBe(2);
    expect(result.weeklyCount).toBe(2);
    expect(result.dailyCount).toBe(2);
    // 2 monthly + 2 weekly + 2 daily = 6 distinct protected dirs.
    expect(result.keptBackupDirs).toHaveLength(6);
    expect(result.keptBackupDirs.map(p => basename(p))).toContain('20260303T010000000Z');
  });

  it('ignores non-timestamp directories: never prunes them, never lets them displace the newest backup', () => {
    // A stray directory sorting lexicographically after every timestamp would,
    // without name filtering, be treated as "newest" — hijacking both the
    // fail-closed floor and the rotating tier, and exposing the genuine newest
    // backup to pruning.
    const root = makeBackupRoot([
      '20260301T010000000Z',
      '20260301T130000000Z',
      '20260302T130000000Z', // genuine newest
      'zzz-operator-inspect',
    ]);

    const result = applyTieredRetention(root, {
      maxRotatingBackups: 1,
      maxDailyBackups: 0,
      maxWeeklyBackups: 0,
      maxMonthlyBackups: 0,
    });

    const kept = result.keptBackupDirs.map(p => basename(p));
    const pruned = result.prunedBackupDirs.map(p => basename(p));
    // The genuine newest survives via the rotating slot and the stray dir is
    // untouched — absent from both kept and pruned (it exists but is invisible
    // to retention).
    expect(kept).toEqual(['20260302T130000000Z']);
    expect(pruned).not.toContain('zzz-operator-inspect');
    expect(pruned).toEqual(['20260301T010000000Z', '20260301T130000000Z']);
    expect(existsSync(join(root, 'zzz-operator-inspect'))).toBe(true);
  });
});

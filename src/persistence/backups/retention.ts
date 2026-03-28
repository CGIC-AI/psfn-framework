import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface TieredRetentionOptions {
  maxRotatingBackups: number;
  maxWeeklyBackups: number;
  maxMonthlyBackups: number;
}

export interface TieredRetentionResult {
  prunedBackupDirs: string[];
  keptBackupDirs: string[];
  weeklyCount: number;
  monthlyCount: number;
}

/** ISO timestamp directory names are YYYYMMDDTHHMMSSFFFZ format — sortable as strings. */
function listBackupDirectories(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Returns an ISO year-week string (e.g. "2026-W11") derived from the backup
 * directory name timestamp.  The directory name format is YYYYMMDDTHHMMSSFFFZ.
 */
function isoWeekKey(dirName: string): string {
  const date = parseDirDate(dirName);
  if (!date) return dirName;

  // ISO week: Thu of the week determines the year.
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNumber = Math.ceil(
    ((thursday.getTime() - jan1.getTime()) / 86400000 + 1) / 7,
  );
  return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Returns a year-month string (e.g. "2026-03") derived from the directory name.
 */
function isoMonthKey(dirName: string): string {
  const date = parseDirDate(dirName);
  if (!date) return dirName;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function parseDirDate(dirName: string): Date | null {
  // Format: YYYYMMDDTHHMMSSFFFZ  e.g. 20260317T103045123Z
  const match = dirName.match(/^(\d{4})(\d{2})(\d{2})T/);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

/**
 * Applies GFS (Grandfather-Father-Son) tiered retention to a backup root
 * directory.  Returns removed and retained directory paths.
 *
 * Retention tiers (applied oldest-first, so promotions protect older backups):
 *   Monthly  — the most recent backup from each calendar month, up to maxMonthly
 *   Weekly   — the most recent backup from each ISO week (not already monthly),
 *              up to maxWeekly
 *   Rotating — the maxRotating most recent backups not already protected above
 *
 * All unprotected backups are pruned.
 */
export function applyTieredRetention(
  rootDir: string,
  options: TieredRetentionOptions,
): TieredRetentionResult {
  const { maxRotatingBackups, maxWeeklyBackups, maxMonthlyBackups } = options;
  const dirs = listBackupDirectories(rootDir);

  if (dirs.length === 0) {
    return { prunedBackupDirs: [], keptBackupDirs: [], weeklyCount: 0, monthlyCount: 0 };
  }

  const protected_ = new Set<string>();

  // Build month → last-dir mapping (newest backup per month wins)
  const monthToDir = new Map<string, string>();
  for (const dir of dirs) {
    monthToDir.set(isoMonthKey(dir), dir);
  }
  // Keep the latest maxMonthlyBackups calendar months, most recent first
  const monthKeys = [...monthToDir.keys()].sort((a, b) => b.localeCompare(a));
  let monthlyCount = 0;
  for (const key of monthKeys) {
    if (monthlyCount >= maxMonthlyBackups) break;
    const dir = monthToDir.get(key)!;
    protected_.add(dir);
    monthlyCount++;
  }

  // Build week → last-dir mapping (newest backup per week wins)
  const weekToDir = new Map<string, string>();
  for (const dir of dirs) {
    weekToDir.set(isoWeekKey(dir), dir);
  }
  // Keep the latest maxWeeklyBackups ISO weeks, most recent first, excluding monthly slots
  const weekKeys = [...weekToDir.keys()].sort((a, b) => b.localeCompare(a));
  let weeklyCount = 0;
  for (const key of weekKeys) {
    if (weeklyCount >= maxWeeklyBackups) break;
    const dir = weekToDir.get(key)!;
    if (!protected_.has(dir)) {
      protected_.add(dir);
      weeklyCount++;
    }
  }

  // Keep the maxRotatingBackups most recent backups not already protected
  const rotating = [...dirs]
    .reverse()
    .filter(dir => !protected_.has(dir));
  for (let i = 0; i < Math.min(maxRotatingBackups, rotating.length); i++) {
    protected_.add(rotating[i]);
  }

  const kept: string[] = [];
  const pruned: string[] = [];
  for (const dir of dirs) {
    if (protected_.has(dir)) {
      kept.push(join(rootDir, dir));
    } else {
      pruned.push(join(rootDir, dir));
    }
  }

  for (const path of pruned) {
    rmSync(path, { recursive: true, force: true });
  }

  return {
    prunedBackupDirs: pruned,
    keptBackupDirs: kept,
    weeklyCount,
    monthlyCount,
  };
}

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { resolvePendingCapabilityNoticesPath } from '../../persistence/layout.js';
import { isRecord } from '../../shared/utils/types.js';
import type { CapabilityGrantSnapshot } from './access.js';
import { isCapabilityToken, type CapabilityToken } from './tokens.js';
import type { CapabilityTier } from './tier-types.js';
import { isCapabilityTier } from './tiers.js';

export interface CapabilityTierChange {
  previous: {
    tier: CapabilityTier;
    grantedTokens: readonly CapabilityToken[];
  };
  current: {
    tier: CapabilityTier;
    grantedTokens: readonly CapabilityToken[];
  };
  granted: readonly CapabilityToken[];
  withdrawn: readonly CapabilityToken[];
}

export function buildCapabilityTierChange(
  previous: CapabilityGrantSnapshot,
  current: CapabilityGrantSnapshot,
): CapabilityTierChange | null {
  const previousTokens = new Set(previous.grantedTokens);
  const currentTokens = new Set(current.grantedTokens);
  const granted = current.grantedTokens.filter(token => !previousTokens.has(token));
  const withdrawn = previous.grantedTokens.filter(token => !currentTokens.has(token));
  if (
    previous.tier === current.tier
    && granted.length === 0
    && withdrawn.length === 0
  ) {
    return null;
  }

  return {
    previous: {
      tier: previous.tier,
      grantedTokens: [...previous.grantedTokens],
    },
    current: {
      tier: current.tier,
      grantedTokens: [...current.grantedTokens],
    },
    granted,
    withdrawn,
  };
}

function formatTokenList(tokens: readonly CapabilityToken[]): string {
  return tokens.length > 0 ? tokens.join(', ') : 'none';
}

export function formatCapabilityTierChangeNotice(change: CapabilityTierChange): string {
  return [
    '[System notice: capability access changed]',
    `The Operator changed your capability tier from "${change.previous.tier}" to "${change.current.tier}".`,
    `Current granted capabilities: ${formatTokenList(change.current.grantedTokens)}.`,
    `Newly granted: ${formatTokenList(change.granted)}.`,
    `Withdrawn: ${formatTokenList(change.withdrawn)}.`,
    'This was an operator change, not a fault in you. If it affects a conversation, '
      + 'you can relay this exact status to your Partner and ask the Operator about the change.',
  ].join(' ');
}

interface PendingCapabilityTierChangeRecord {
  schemaVersion: 1;
  change: CapabilityTierChange;
}

function parseTokenList(value: unknown, field: string): CapabilityToken[] {
  if (!Array.isArray(value) || !value.every(isCapabilityToken)) {
    throw new Error(`Invalid pending capability notice: ${field} must contain known tokens`);
  }
  return [...new Set(value)];
}

function parseGrantState(value: unknown, field: string): CapabilityTierChange['current'] {
  if (!isRecord(value) || !isCapabilityTier(value.tier)) {
    throw new Error(`Invalid pending capability notice: ${field}.tier is invalid`);
  }
  return {
    tier: value.tier,
    grantedTokens: parseTokenList(value.grantedTokens, `${field}.grantedTokens`),
  };
}

function parsePendingRecord(value: unknown): PendingCapabilityTierChangeRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.change)) {
    throw new Error('Invalid pending capability notice record');
  }
  return {
    schemaVersion: 1,
    change: {
      previous: parseGrantState(value.change.previous, 'previous'),
      current: parseGrantState(value.change.current, 'current'),
      granted: parseTokenList(value.change.granted, 'granted'),
      withdrawn: parseTokenList(value.change.withdrawn, 'withdrawn'),
    },
  };
}

function serializePendingRecord(change: CapabilityTierChange): string {
  return `${JSON.stringify({ schemaVersion: 1, change } satisfies PendingCapabilityTierChangeRecord)}\n`;
}

export function enqueuePendingCapabilityTierChangeNotice(
  companionDataDir: string,
  change: CapabilityTierChange,
): void {
  const path = resolvePendingCapabilityNoticesPath(companionDataDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, serializePendingRecord(change), 'utf8');
}

function restoreClaimedNotices(queuePath: string, claimedPath: string, raw: string): void {
  appendFileSync(queuePath, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
  unlinkSync(claimedPath);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

function recoverAbandonedNoticeClaims(queuePath: string): void {
  const queueName = basename(queuePath);
  const claimPrefix = `${queueName}.drain-`;
  let entries: string[];
  try {
    entries = readdirSync(dirname(queuePath));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.startsWith(claimPrefix)) continue;
    const claimedPid = Number.parseInt(
      entry.slice(claimPrefix.length).split('-', 1)[0] ?? '',
      10,
    );
    if (
      Number.isInteger(claimedPid)
      && claimedPid > 0
      && claimedPid !== process.pid
      && isProcessAlive(claimedPid)
    ) {
      continue;
    }
    const claimedPath = join(dirname(queuePath), entry);
    const raw = readFileSync(claimedPath, 'utf8');
    // At-least-once recovery: append before unlinking. A crash between these
    // operations can duplicate a notice, but can never silently lose it.
    restoreClaimedNotices(queuePath, claimedPath, raw);
  }
}

export function deliverPendingCapabilityTierChangeNotices(
  companionDataDir: string,
  deliver: (notice: string) => void,
): number {
  const queuePath = resolvePendingCapabilityNoticesPath(companionDataDir);
  recoverAbandonedNoticeClaims(queuePath);
  const claimedPath = `${queuePath}.drain-${process.pid}-${randomUUID()}`;
  try {
    renameSync(queuePath, claimedPath);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return 0;
    throw error;
  }

  const raw = readFileSync(claimedPath, 'utf8');
  let records: PendingCapabilityTierChangeRecord[];
  try {
    records = raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map((line) => parsePendingRecord(JSON.parse(line) as unknown));
  } catch (error) {
    restoreClaimedNotices(queuePath, claimedPath, raw);
    throw error;
  }

  for (let index = 0; index < records.length; index += 1) {
    try {
      deliver(formatCapabilityTierChangeNotice(records[index]!.change));
    } catch (error) {
      const remaining = records
        .slice(index)
        .map(record => serializePendingRecord(record.change))
        .join('');
      restoreClaimedNotices(queuePath, claimedPath, remaining);
      throw error;
    }
  }

  unlinkSync(claimedPath);
  return records.length;
}

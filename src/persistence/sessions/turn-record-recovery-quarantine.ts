import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import { isRecord } from '../../shared/utils/types.js';
import { scanJsonlFileBackward } from '../jsonl-segments.js';

const log = createComponentLogger('TurnRecordRecoveryQuarantine');
const TURN_RECORD_RECOVERY_QUARANTINE_REASON = 'invalid_turn_record_recovery_row';

function appendDurableEvidence(path: string, evidence: Record<string, unknown>): void {
  const created = !existsSync(path);
  const descriptor = openSync(path, 'a', 0o600);
  try {
    const serialized = Buffer.from(`${JSON.stringify(evidence)}\n`, 'utf8');
    let offset = 0;
    while (offset < serialized.length) {
      offset += writeSync(
        descriptor,
        serialized,
        offset,
        serialized.length - offset,
      );
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (created) {
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

function hasEvidence(
  quarantinePath: string,
  rowIdentity: string,
  scanChunkBytes: number,
): boolean {
  if (!existsSync(quarantinePath)) return false;
  return scanJsonlFileBackward(
    quarantinePath,
    { chunkBytes: scanChunkBytes },
    (line) => {
      if (!line.trim()) return false;
      let evidence: unknown;
      try {
        evidence = JSON.parse(line) as unknown;
      } catch {
        throw new Error('TurnRecord recovery quarantine evidence is malformed');
      }
      return isRecord(evidence) && evidence.rowIdentity === rowIdentity;
    },
  );
}

/**
 * Persist one idempotent, content-free receipt for a structurally invalid row.
 * The append-only source retains the raw recovery artifact; callers may skip
 * it only after this receipt is fsync-durable.
 *
 * The caller holds the source TurnRecord rotation lock so concurrent recovery
 * workers cannot append duplicate evidence.
 */
export function quarantineTurnRecordRecoveryLine(
  activePath: string,
  channelId: string,
  rawLine: string,
  rowIdentity: string,
  scanChunkBytes: number,
): boolean {
  if (!Number.isSafeInteger(scanChunkBytes) || scanChunkBytes < 1) {
    throw new Error('TurnRecord recovery quarantine scan chunk must be a positive safe integer');
  }
  if (!rowIdentity.trim()) {
    throw new Error('TurnRecord recovery quarantine row identity must be non-empty');
  }
  const quarantinePath = `${activePath}.quarantine`;
  if (hasEvidence(quarantinePath, rowIdentity, scanChunkBytes)) return false;

  const rawLength = Buffer.byteLength(rawLine, 'utf8');
  appendDurableEvidence(quarantinePath, {
    quarantinedAt: Date.now(),
    channelId,
    rawLength,
    reason: TURN_RECORD_RECOVERY_QUARANTINE_REASON,
    rowIdentity,
  });
  log.error('turn_record_recovery_line_quarantined', {
    channelId,
    rawLength,
    reason: TURN_RECORD_RECOVERY_QUARANTINE_REASON,
  });
  return true;
}

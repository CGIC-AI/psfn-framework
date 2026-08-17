import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CorruptTurnRecordRecoveryEvidenceSkip } from '../../core/agent/background-work/recovery-contract.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { fingerprintJournalArchiveChain } from './store/journal-chain-runtime.js';

function fingerprintOwnerSource(ownerSessionId: string, archiveFingerprint: string): string {
  const owner = ownerSessionId.trim();
  if (!owner || !archiveFingerprint) {
    throw new Error('Background-work recovery owner evidence must be non-empty');
  }
  return createHash('sha256')
    .update(JSON.stringify(['background-work-recovery-owner-v1', owner, archiveFingerprint]))
    .digest('hex');
}

export function createCorruptTurnRecordRecoveryEvidence(
  ownerSessionId: string,
  sourceArchivePaths: readonly string[],
  archiveFingerprint: string,
): CorruptTurnRecordRecoveryEvidenceSkip {
  if (sourceArchivePaths.length === 0) {
    throw new Error('Background-work recovery owner must have at least one source archive');
  }
  return {
    errno: 'EBADMSG',
    ownerSessionId,
    sourceFingerprint: fingerprintOwnerSource(ownerSessionId, archiveFingerprint),
    sourceArchivePaths: sourceArchivePaths.map(path => resolve(path)),
  };
}

/** Re-read the exact filesystem generation carried by a trusted in-process skip. */
export function readCorruptTurnRecordRecoveryEvidence(
  ownerSessionId: string,
  sourceArchivePaths: readonly string[],
): CorruptTurnRecordRecoveryEvidenceSkip | null {
  if (sourceArchivePaths.length === 0) return null;
  const archivePort = createFilesystemSessionArchivePort();
  const resolvedPaths = sourceArchivePaths.map(path => resolve(path));
  const archives = resolvedPaths.map(path => archivePort.openArchive(ownerSessionId, path));
  const archiveFingerprint = fingerprintJournalArchiveChain(archivePort, archives);
  if (!archiveFingerprint) return null;
  return createCorruptTurnRecordRecoveryEvidence(
    ownerSessionId,
    resolvedPaths,
    archiveFingerprint,
  );
}

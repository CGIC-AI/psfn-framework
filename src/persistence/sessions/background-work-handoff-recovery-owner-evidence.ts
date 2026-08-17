import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CorruptTurnRecordRecoveryEvidenceSkip } from '../../core/agent/background-work/recovery-contract.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { fingerprintJournalArchiveGeneration } from './store/journal-chain-runtime.js';

function fingerprintOwnerSource(
  ownerSessionId: string,
  sourceChannelId: string,
  archiveFingerprint: string,
): string {
  const owner = ownerSessionId.trim();
  const physicalChannel = sourceChannelId.trim();
  if (!owner || !physicalChannel || !archiveFingerprint) {
    throw new Error('Background-work recovery owner evidence must be non-empty');
  }
  return createHash('sha256')
    .update(JSON.stringify([
      'background-work-recovery-owner-v2',
      owner,
      physicalChannel,
      archiveFingerprint,
    ]))
    .digest('hex');
}

export function createCorruptTurnRecordRecoveryEvidence(
  ownerSessionId: string,
  sourceChannelId: string,
  sourceArchivePaths: readonly string[],
  archiveFingerprint: string,
): CorruptTurnRecordRecoveryEvidenceSkip {
  if (sourceArchivePaths.length === 0) {
    throw new Error('Background-work recovery owner must have at least one source archive');
  }
  return {
    errno: 'EBADMSG',
    ownerSessionId,
    sourceChannelId,
    sourceFingerprint: fingerprintOwnerSource(
      ownerSessionId,
      sourceChannelId,
      archiveFingerprint,
    ),
    sourceArchiveFingerprint: archiveFingerprint,
    sourceArchivePaths: sourceArchivePaths.map(path => resolve(path)),
  };
}

/** Re-read the exact filesystem generation carried by a trusted in-process skip. */
export function readCorruptTurnRecordRecoveryEvidence(
  ownerSessionId: string,
  sourceChannelId: string,
  sourceArchivePaths: readonly string[],
): CorruptTurnRecordRecoveryEvidenceSkip | null {
  if (sourceArchivePaths.length === 0) return null;
  const archivePort = createFilesystemSessionArchivePort();
  const resolvedPaths = sourceArchivePaths.map(path => resolve(path));
  const archives = resolvedPaths.map(path => archivePort.openArchive(sourceChannelId, path));
  const archiveFingerprint = fingerprintJournalArchiveGeneration(archivePort, archives);
  if (!archiveFingerprint) return null;
  return createCorruptTurnRecordRecoveryEvidence(
    ownerSessionId,
    sourceChannelId,
    resolvedPaths,
    archiveFingerprint,
  );
}

import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SessionHmacKeyring } from '../journals/journal-utils.js';
import {
  TurnRecordRecoveryEvidenceError,
  type BackgroundWorkHandoffRecoveryDisposition,
  type CorruptTurnRecordRecoveryEvidenceSkip,
} from '../../core/agent/background-work/recovery-contract.js';
import { createComponentLogger } from '../../shared/logger.js';
import { readCorruptTurnRecordRecoveryEvidence } from '../sessions/background-work-handoff-recovery-owner-evidence.js';
import type { SessionIntegrityProvider } from '../sessions/store-primitives.js';
import { withSessionJournalWriteLock } from '../sessions/store/session-journal-write-lock.js';
import {
  runSessionIntegrityRepair,
  type SessionIntegrityRepairAuditSink,
} from './integrity-repair.js';
import { BackgroundWorkHandoffRecoveryDispositionStore } from './background-work-handoff-recovery-disposition-store.js';

const log = createComponentLogger('BackgroundWorkHandoffRecoveryDisposition');

export const BACKGROUND_WORK_HANDOFF_RECOVERY_DISPOSITION_AUDIT_EVENT =
  'background_work_handoff_recovery_disposition';

interface BackgroundWorkHandoffRecoveryDispositionOptionsBase {
  sessionsDir: string;
  backupRootDir: string;
  audit?: SessionIntegrityRepairAuditSink;
}

type BackgroundWorkHandoffRecoveryDispositionOptions =
  BackgroundWorkHandoffRecoveryDispositionOptionsBase & (
    | { keyring: SessionHmacKeyring; integrityProvider?: never }
    | { integrityProvider: SessionIntegrityProvider; keyring?: never }
  );

function assertSourceArchivesContained(
  sessionsDir: string,
  skip: CorruptTurnRecordRecoveryEvidenceSkip,
): void {
  const root = realpathSync(resolve(sessionsDir));
  for (const sourcePath of skip.sourceArchivePaths) {
    const resolvedPath = resolve(sourcePath);
    if (!lstatSync(resolvedPath).isFile()) {
      throw new Error('Background-work recovery source archive must be a regular file');
    }
    const relativePath = relative(root, realpathSync(resolvedPath));
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('Background-work recovery source archive is outside the sessions root');
    }
  }
}

/**
 * Converts deterministic EBADMSG authority poison into a crash-durable
 * disposition. Canonical repair keeps its existing backup/quarantine path;
 * when repair proves there is nothing to rewrite, an exact-generation receipt
 * retires only that physical owner while its raw source remains in place.
 * Logs, audit events, and receipts contain only bounded structural evidence.
 */
export function createBackgroundWorkHandoffRecoveryDisposition(
  options: BackgroundWorkHandoffRecoveryDispositionOptions,
): BackgroundWorkHandoffRecoveryDisposition {
  const dispositionStore = new BackgroundWorkHandoffRecoveryDispositionStore(
    options.backupRootDir,
  );
  return {
    isCorruptOwnerRetired: skip => dispositionStore.has(skip),
    quarantineCorruptOwner: async (skip) => {
      const ownerSessionId = skip.ownerSessionId.trim();
      if (!ownerSessionId) {
        throw new Error('Corrupt background-work recovery owner must be non-empty');
      }
      assertSourceArchivesContained(options.sessionsDir, skip);

      mkdirSync(options.backupRootDir, { recursive: true });
      const backupDir = mkdtempSync(join(
        options.backupRootDir,
        'background-work-handoff-',
      ));
      try {
        const report = runSessionIntegrityRepair({
          sessionsDir: options.sessionsDir,
          backupDir,
          reason: 'Automatic EBADMSG background-work handoff recovery quarantine',
          targetChannelIds: [ownerSessionId],
          ...(options.audit ? { audit: options.audit } : {}),
          ...(options.integrityProvider !== undefined
            ? { integrityProvider: options.integrityProvider }
            : { keyring: options.keyring }),
        });
        const hasDurableDisposition = report.journal.modifiedFiles > 0
          && (report.journal.modifiedEntries > 0 || report.journal.quarantinedRows > 0);
        if (!hasDurableDisposition) {
          let newlyRetired = false;
          withSessionJournalWriteLock(skip.sourceArchivePaths[0]!, () => {
            const current = readCorruptTurnRecordRecoveryEvidence(
              ownerSessionId,
              skip.sourceArchivePaths,
            );
            if (!current || current.sourceFingerprint !== skip.sourceFingerprint) {
              throw new TurnRecordRecoveryEvidenceError(
                'EBADMSG recovery owner changed before its terminal disposition became durable',
                { code: 'ESTALE' },
              );
            }
            newlyRetired = dispositionStore.retire(skip);
          });
          options.audit?.append(BACKGROUND_WORK_HANDOFF_RECOVERY_DISPOSITION_AUDIT_EVENT, {
            outcome: 'retired_unchanged_owner',
            errno: skip.errno,
            ownerSessionId,
            sourceFingerprint: skip.sourceFingerprint,
            newlyRetired,
            modifiedFiles: report.journal.modifiedFiles,
            modifiedEntries: report.journal.modifiedEntries,
            quarantinedRows: report.journal.quarantinedRows,
          });
          log.warn('background_work_handoff_recovery_owner_retired', {
            errno: skip.errno,
            ownerSessionId,
            sourceFingerprint: skip.sourceFingerprint,
            newlyRetired,
          });
          return;
        }
        log.error('background_work_handoff_recovery_owner_quarantined', {
          errno: skip.errno,
          ownerSessionId,
          modifiedFiles: report.journal.modifiedFiles,
          quarantinedRows: report.journal.quarantinedRows,
        });
      } catch (error) {
        log.error('background_work_handoff_recovery_owner_quarantine_failed', {
          errno: skip.errno,
          ownerSessionId,
          failure: error instanceof Error ? error.name : 'UnknownError',
        });
        throw error;
      }
    },
  };
}

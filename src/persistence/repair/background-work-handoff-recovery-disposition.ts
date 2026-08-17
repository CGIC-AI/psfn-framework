import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionHmacKeyring } from '../journals/journal-utils.js';
import {
  TURN_RECORD_RECOVERY_CORRUPT_EVIDENCE_CODE,
  type BackgroundWorkHandoffRecoveryDisposition,
} from '../../core/agent/background-work/recovery-contract.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SessionIntegrityProvider } from '../sessions/store-primitives.js';
import {
  runSessionIntegrityRepair,
  type SessionIntegrityRepairAuditSink,
} from './integrity-repair.js';

const log = createComponentLogger('BackgroundWorkHandoffRecoveryDisposition');

export const BACKGROUND_WORK_HANDOFF_RECOVERY_DISPOSITION_AUDIT_EVENT =
  'background_work_handoff_recovery_disposition';

export class BackgroundWorkHandoffRecoveryDispositionUnresolvedError extends Error {
  readonly code = 'EUNRESOLVED';

  constructor() {
    super('EBADMSG background-work handoff recovery produced no durable repair evidence');
    this.name = 'BackgroundWorkHandoffRecoveryDispositionUnresolvedError';
  }
}

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

/**
 * Converts deterministic EBADMSG authority poison into the existing
 * crash-durable session-integrity quarantine. Raw bytes remain recoverable in
 * the repair backup; logs, audit events, and quarantine receipts contain only
 * bounded structural evidence.
 */
export function createBackgroundWorkHandoffRecoveryDisposition(
  options: BackgroundWorkHandoffRecoveryDispositionOptions,
): BackgroundWorkHandoffRecoveryDisposition {
  return {
    quarantineCorruptOwner: async (skip) => {
      if (skip.errno !== TURN_RECORD_RECOVERY_CORRUPT_EVIDENCE_CODE) {
        throw new Error(`Refusing terminal disposition for retryable recovery evidence ${skip.errno}`);
      }
      const ownerSessionId = skip.ownerSessionId.trim();
      if (!ownerSessionId) {
        throw new Error('Corrupt background-work recovery owner must be non-empty');
      }

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
          options.audit?.append(BACKGROUND_WORK_HANDOFF_RECOVERY_DISPOSITION_AUDIT_EVENT, {
            outcome: 'unresolved',
            errno: skip.errno,
            ownerSessionId,
            modifiedFiles: report.journal.modifiedFiles,
            modifiedEntries: report.journal.modifiedEntries,
            quarantinedRows: report.journal.quarantinedRows,
          });
          throw new BackgroundWorkHandoffRecoveryDispositionUnresolvedError();
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

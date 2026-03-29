import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { readJournalFirstEntry } from '../journals/journal/file-io.js';
import { SessionJournalRuntime } from '../sessions/store/journal-runtime.js';
import { isSessionJournalFilename } from '../sessions/store/channel-filenames.js';
import type { SessionIntegrityProvider } from '../sessions/store-primitives.js';
import type { TranscriptProjectionPort } from '../sessions/transcript-projection-port.js';

export interface TranscriptProjectionRepairFailure {
  channelId: string;
  filePath: string;
  error: string;
}

export interface TranscriptProjectionRepairReport {
  scannedFiles: number;
  rebuiltChannels: number;
  clearedMissingChannels: number;
  driftBefore: number;
  driftAfter: number;
  failures: TranscriptProjectionRepairFailure[];
}

export interface TranscriptProjectionRepairOptions {
  sessionsDir: string;
  transcriptProjection: TranscriptProjectionPort;
  integrityProvider?: SessionIntegrityProvider | null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runTranscriptProjectionRepair(
  options: TranscriptProjectionRepairOptions,
): TranscriptProjectionRepairReport {
  // Rebuild the projection from canonical L0 archive files, never from the projection itself.
  const driftBeforeEntries = options.transcriptProjection.listProjectionDrift();
  const driftBefore = driftBeforeEntries.length;
  if (!existsSync(options.sessionsDir)) {
    return {
      scannedFiles: 0,
      rebuiltChannels: 0,
      clearedMissingChannels: 0,
      driftBefore,
      driftAfter: driftBefore,
      failures: [],
    };
  }

  const archivePort = createFilesystemSessionArchivePort();
  const journalRuntime = new SessionJournalRuntime(
    options.integrityProvider ?? null,
    archivePort,
  );
  const seenChannels = new Set<string>();
  const failures: TranscriptProjectionRepairFailure[] = [];
  let rebuiltChannels = 0;

  const files = readdirSync(options.sessionsDir)
    .filter(isSessionJournalFilename)
    .sort((left, right) => left.localeCompare(right));

  for (const filename of files) {
    const filePath = join(options.sessionsDir, filename);
    const channelId = readJournalFirstEntry(filePath)?.channelId;
    if (!channelId) {
      continue;
    }
    seenChannels.add(channelId);
    try {
      const loaded = journalRuntime.loadChannel(archivePort.openArchive(channelId, filePath));
      options.transcriptProjection.replaceChannelEntries(channelId, loaded.entries);
      rebuiltChannels += 1;
    } catch (error) {
      const message = toErrorMessage(error);
      options.transcriptProjection.markProjectionDrift(channelId, message);
      failures.push({
        channelId,
        filePath,
        error: message,
      });
    }
  }

  let clearedMissingChannels = 0;
  for (const drift of driftBeforeEntries) {
    if (seenChannels.has(drift.channelId)) {
      continue;
    }
    options.transcriptProjection.replaceChannelEntries(drift.channelId, []);
    clearedMissingChannels += 1;
  }

  return {
    scannedFiles: files.length,
    rebuiltChannels,
    clearedMissingChannels,
    driftBefore,
    driftAfter: options.transcriptProjection.listProjectionDrift().length,
    failures,
  };
}

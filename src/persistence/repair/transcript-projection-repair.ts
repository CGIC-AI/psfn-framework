import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { SessionJournalRuntime } from '../sessions/store/journal-runtime.js';
import { discoverSessionFileChains } from '../sessions/store/session-file-chains.js';
import { sessionIdForChannelFile } from '../sessions/store/session-index-keys.js';
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

  const discovered = discoverSessionFileChains(options.sessionsDir);
  const sessionCountsByChannel = new Map<string, number>();
  for (const chain of discovered.chains) {
    sessionCountsByChannel.set(
      chain.channelId,
      (sessionCountsByChannel.get(chain.channelId) ?? 0) + 1,
    );
  }

  for (const chain of discovered.chains) {
    const sessionId = sessionIdForChannelFile(
      chain.channelId,
      chain.rootFilename,
      (sessionCountsByChannel.get(chain.channelId) ?? 0) > 1,
    );
    seenChannels.add(sessionId);
    try {
      const loaded = journalRuntime.loadChannelChain(chain.filePaths.map(filePath => (
        archivePort.openArchive(chain.channelId, filePath)
      )));
      options.transcriptProjection.replaceChannelEntries(sessionId, loaded.entries);
      rebuiltChannels += 1;
    } catch (error) {
      const message = toErrorMessage(error);
      options.transcriptProjection.markProjectionDrift(sessionId, message);
      failures.push({
        channelId: sessionId,
        filePath: chain.filePaths[0]!,
        error: message,
      });
    }
  }

  for (const chain of discovered.incompleteChains) {
    const sessionId = sessionIdForChannelFile(
      chain.channelId,
      chain.rootFilename,
      // Runtime index recovery excludes incomplete chains entirely. Never let
      // one change the valid-chain ID; give the incomplete artifact its own
      // diagnostic ID when it would otherwise collide with a valid session.
      (sessionCountsByChannel.get(chain.channelId) ?? 0) > 0,
    );
    const message = `Cannot rebuild projection from incomplete L0 chain; segments: ${chain.segmentNumbers.join(', ')}`;
    seenChannels.add(sessionId);
    options.transcriptProjection.markProjectionDrift(sessionId, message);
    failures.push({
      channelId: sessionId,
      filePath: join(options.sessionsDir, chain.rootFilename),
      error: message,
    });
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
    scannedFiles: discovered.chains.reduce((count, chain) => count + chain.filePaths.length, 0)
      + discovered.incompleteChains.reduce((count, chain) => count + chain.segmentNumbers.length, 0),
    rebuiltChannels,
    clearedMissingChannels,
    driftBefore,
    driftAfter: options.transcriptProjection.listProjectionDrift().length,
    failures,
  };
}

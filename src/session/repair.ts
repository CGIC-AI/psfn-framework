import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { quarantineSidecarPath, readJournalFile } from './journal-utils.js';

export interface SessionRepairFileReport {
  filePath: string;
  channelId: string | null;
  loadedEntries: number;
  quarantinedEntries: number;
  quarantinePath: string;
}

export interface SessionRepairReport {
  scannedFiles: number;
  loadedEntries: number;
  quarantinedEntries: number;
  filesWithCorruption: SessionRepairFileReport[];
}

export function runSessionRepairScan(sessionsDir: string): SessionRepairReport {
  if (!existsSync(sessionsDir)) {
    return {
      scannedFiles: 0,
      loadedEntries: 0,
      quarantinedEntries: 0,
      filesWithCorruption: [],
    };
  }

  const files = readdirSync(sessionsDir).filter(filename => filename.endsWith('.jsonl'));
  const filesWithCorruption: SessionRepairFileReport[] = [];
  let loadedEntries = 0;
  let quarantinedEntries = 0;

  for (const filename of files) {
    const filePath = join(sessionsDir, filename);
    const parsed = readJournalFile(filePath);
    loadedEntries += parsed.entries.length;
    quarantinedEntries += parsed.quarantined.length;

    if (parsed.quarantined.length === 0) continue;

    filesWithCorruption.push({
      filePath,
      channelId: parsed.entries[0]?.channelId ?? null,
      loadedEntries: parsed.entries.length,
      quarantinedEntries: parsed.quarantined.length,
      quarantinePath: quarantineSidecarPath(filePath),
    });
  }

  return {
    scannedFiles: files.length,
    loadedEntries,
    quarantinedEntries,
    filesWithCorruption,
  };
}

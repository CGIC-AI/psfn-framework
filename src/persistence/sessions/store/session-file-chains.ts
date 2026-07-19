import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isReadableSessionJournalFilename,
  isSessionJournalFilename,
  parseSessionSegmentFilename,
  readChannelIdFromFile,
} from './channel-filenames.js';

export interface SessionFileChain {
  channelId: string;
  rootFilename: string;
  filenames: string[];
  filePaths: string[];
}

export interface IncompleteSessionFileChain {
  channelId: string;
  rootFilename: string;
  segmentNumbers: number[];
}

export function discoverSessionFileChains(
  sessionsDir: string,
  indexedChannelByFilename: ReadonlyMap<string, string> = new Map(),
  options: { includeLegacyFilenames?: boolean } = {},
): {
  chains: SessionFileChain[];
  incompleteChains: IncompleteSessionFileChain[];
} {
  const scanned = readdirSync(sessionsDir)
    .filter(filename => (
      isSessionJournalFilename(filename)
      && (options.includeLegacyFilenames !== false || isReadableSessionJournalFilename(filename))
    ))
    .map((filename) => {
      const filePath = join(sessionsDir, filename);
      const channelId = readChannelIdFromFile(filePath) ?? indexedChannelByFilename.get(filename);
      const segment = parseSessionSegmentFilename(filename);
      return {
        filename,
        filePath,
        channelId,
        rootFilename: segment.rootFilename,
        segmentNumber: segment.segmentNumber,
      };
    });

  const groupedByRoot = new Map<string, typeof scanned>();
  for (const file of scanned) {
    const group = groupedByRoot.get(file.rootFilename) ?? [];
    group.push(file);
    groupedByRoot.set(file.rootFilename, group);
  }

  const chains: SessionFileChain[] = [];
  const incompleteChains: IncompleteSessionFileChain[] = [];
  for (const group of groupedByRoot.values()) {
    const ordered = [...group].sort((left, right) => left.segmentNumber - right.segmentNumber);
    const channelIds = [...new Set(ordered.map(entry => entry.channelId).filter(Boolean))] as string[];
    const channelId = channelIds.length === 1 ? channelIds[0]! : null;
    if (
      !channelId
      || !ordered.every((entry, index) => entry.segmentNumber === index + 1)
    ) {
      incompleteChains.push({
        channelId: channelId ?? (channelIds.join(',') || 'unknown'),
        rootFilename: ordered[0]!.rootFilename,
        segmentNumbers: ordered.map(entry => entry.segmentNumber),
      });
      continue;
    }
    chains.push({
      channelId,
      rootFilename: ordered[0]!.rootFilename,
      filenames: ordered.map(entry => entry.filename),
      filePaths: ordered.map(entry => entry.filePath),
    });
  }

  chains.sort((left, right) => left.rootFilename.localeCompare(right.rootFilename));
  incompleteChains.sort((left, right) => left.rootFilename.localeCompare(right.rootFilename));
  return { chains, incompleteChains };
}

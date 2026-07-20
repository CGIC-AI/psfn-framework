import type { SessionEntry } from '../session/types.js';

function parseWakeupNoteTimestamp(
  entry: SessionEntry,
  sources: ReadonlySet<string>,
): number | null {
  if (entry.role !== 'system' || !entry.metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const lane = (parsed as { sessionLane?: unknown }).sessionLane;
  if (typeof lane !== 'object' || lane === null || Array.isArray(lane)) return null;
  const source = (lane as { source?: unknown }).source;
  return typeof source === 'string' && sources.has(source) ? entry.timestamp : null;
}

export function findLatestTemporalWakeupNote(
  entries: readonly SessionEntry[],
  sources: ReadonlySet<string>,
): SessionEntry | undefined {
  let latest: SessionEntry | undefined;
  for (const entry of entries) {
    const timestamp = parseWakeupNoteTimestamp(entry, sources);
    if (timestamp === null) continue;
    if (!latest || timestamp > latest.timestamp) {
      latest = entry;
    }
  }
  return latest;
}

export function findLatestTemporalWakeupNoteAt(
  entries: readonly SessionEntry[],
  sources: ReadonlySet<string>,
): number | undefined {
  return findLatestTemporalWakeupNote(entries, sources)?.timestamp;
}

export function latestTemporalWakeupTimestamp(
  ...timestamps: ReadonlyArray<number | undefined>
): number | undefined {
  const finite = timestamps.filter(
    (timestamp): timestamp is number => timestamp !== undefined && Number.isFinite(timestamp),
  );
  return finite.length > 0 ? Math.max(...finite) : undefined;
}

export function temporalWakeupLocalDateKey(timestampMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(timestampMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function didTemporalWakeupNoteWithContentLandOnLocalDate(input: {
  persistedEntries: readonly SessionEntry[];
  sources: ReadonlySet<string>;
  contentMarker: string;
  inMemoryNoteAtMs?: number;
  observedAtMs: number;
  timeZone: string;
}): boolean {
  const persistedNoteAtMs = findLatestTemporalWakeupNoteAt(
    input.persistedEntries.filter(entry => entry.content.includes(input.contentMarker)),
    input.sources,
  );
  const latestNoteAtMs = latestTemporalWakeupTimestamp(
    persistedNoteAtMs,
    input.inMemoryNoteAtMs,
  );
  return latestNoteAtMs !== undefined
    && temporalWakeupLocalDateKey(latestNoteAtMs, input.timeZone)
      === temporalWakeupLocalDateKey(input.observedAtMs, input.timeZone);
}

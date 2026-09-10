// ── Per-world notes: the companion's own map of a shared world (S13, 2nsfo) ──
//
// The world's server gives the map it has (the Hub's place map, the room the
// body stands in, terrain: `world-plane-map.ts`). What the companion LEARNS by
// being there — the landmarks it saw and where, the rooms it entered, which
// place led to which, who it ran into near what — is its own knowledge of that
// world, kept per world and per companion. A MUD player builds a map from text
// the same way. These are the shapes; the wiki-backed library that maintains
// them lives in `src/faculties/wiki/world-notes.ts` and the world tool feeds it
// from perception and movement so a nursery-tier companion accumulates its
// map without any model-authored write. Federation groundwork: a companion
// that travels between linked worlds remembers each one by these notes.

export type WorldLandmarkKind = 'thing' | 'room' | 'place';

export interface WorldLandmark {
  /** Stable key: `thing:<id>`, `room:<label>`, `place:<placeId>`. */
  id: string;
  kind: WorldLandmarkKind;
  label: string;
  x?: number;
  z?: number;
  /** For a room: what the world says leads out of it. */
  waysOut?: string[];
  detail?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
}

/** "From here I reached there": adjacency learned from the companion's own moves. */
export interface WorldRoute {
  from: string;
  to: string;
  firstAt: string;
  lastAt: string;
  count: number;
}

/**
 * Who was met where. A reference only: the participant id the world uses
 * and, when the runtime resolved one, the contact id. Names, kinds and
 * anything about the person belong to contacts, never here.
 */
export interface WorldEncounter {
  participantId: string;
  contactId?: string;
  /** The nearest remembered landmark at the time, when one was close. */
  near?: string;
  x?: number;
  z?: number;
  firstAt: string;
  lastAt: string;
  count: number;
}

/** A note the companion chose to keep about the world, in its own words. */
export interface WorldNote {
  id: string;
  text: string;
  /** A landmark id or participant id the note is about, when it is about one. */
  about?: string;
  at: string;
}

export interface WorldNotes {
  schemaVersion: 1;
  world: string;
  landmarks: WorldLandmark[];
  routes: WorldRoute[];
  encounters: WorldEncounter[];
  notes: WorldNote[];
  /** Perceptions folded in; a rough "how well do I know this world". */
  perceptions: number;
  createdAt: string;
  updatedAt: string;
}

/** What a perception contributes; a projection of the world-avatar perception. */
export interface WorldNotesPerceptionInput {
  world: string;
  capturedAt: string;
  self?: { x?: number; z?: number } | null;
  room?: { label: string; labelled: boolean; waysOut: string[] } | undefined;
  things: ReadonlyArray<{ id: string; label: string; x?: number; z?: number; detail?: string }>;
  people: ReadonlyArray<{ id: string; x?: number; z?: number; contactId?: string }>;
}

export interface WorldNotesReader {
  get(world: string): WorldNotes | undefined;
  /** A short, bounded rendering for the world-plane situated block; empty when nothing is known. */
  summarize(world: string): string;
}

export interface WorldNotesWriter {
  observePerception(input: WorldNotesPerceptionInput): void;
  observeMove(input: { world: string; from?: string; to: string; at: string }): void;
}

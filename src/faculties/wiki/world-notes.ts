// ── Per-world notes library (S13, psfn-framework-2nsfo) ──
//
// The companion's own map of a shared world, kept as ONE runtime-managed
// personal-wiki document per world (`world.<world>`, tag `world-notes`), in
// the reserved namespace the generic `wiki write` cannot touch — the same
// pattern as personal projects. Landmarks, rooms, routes and encounters are
// folded in from the world tool's own perceptions and moves (runtime-derived,
// no model authorship, so a nursery-tier companion still accumulates them);
// `world_note` is the one bounded model-authored addition. Bounded everywhere:
// counts, text lengths, and coordinates rounded to a decimetre.

import { isRecord } from '../../shared/utils/types.js';
import type {
  WorldEncounter,
  WorldLandmark,
  WorldNote,
  WorldNotes,
  WorldNotesPerceptionInput,
  WorldNotesReader,
  WorldNotesWriter,
} from '../../shared/contracts/world-notes.js';
import type { WikiDocument, WikiStorePort } from './types.js';

export const WORLD_NOTES_TAG = 'world-notes';
const WORLD_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/u;
const MAX_LANDMARKS = 200;
const MAX_ROUTES = 200;
const MAX_ENCOUNTERS = 100;
const MAX_NOTES = 64;
const MAX_NOTE_CHARS = 280;
const MAX_LABEL_CHARS = 80;
const NEAR_LANDMARK_M = 6;

export function worldNotesDocId(world: string): string {
  return `world.${world}`;
}

export class WorldNotesLibrary implements WorldNotesReader, WorldNotesWriter {
  constructor(
    private readonly store: WikiStorePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(world: string): WorldNotes | undefined {
    if (!WORLD_NAME_PATTERN.test(world)) return undefined;
    const document = this.store.get(worldNotesDocId(world));
    return document ? parseWorldNotesDocument(document) : undefined;
  }

  listWorlds(): string[] {
    return this.store.list()
      .filter((entry) => entry.tags.includes(WORLD_NOTES_TAG) && entry.id.startsWith('world.'))
      .map((entry) => entry.id.slice('world.'.length));
  }

  observePerception(input: WorldNotesPerceptionInput): void {
    if (!WORLD_NAME_PATTERN.test(input.world)) return;
    const at = input.capturedAt;
    const notes = this.get(input.world) ?? emptyNotes(input.world, at);
    for (const thing of input.things) {
      upsertLandmark(notes, {
        id: `thing:${cleanId(thing.id)}`,
        kind: 'thing',
        label: cleanLabel(thing.label) || cleanId(thing.id),
        ...(finite(thing.x) !== undefined && finite(thing.z) !== undefined ? { x: round(thing.x as number), z: round(thing.z as number) } : {}),
        ...(thing.detail ? { detail: cleanLabel(thing.detail) } : {}),
      }, at);
    }
    if (input.room) {
      const label = cleanLabel(input.room.label);
      if (label) {
        upsertLandmark(notes, {
          id: `room:${label.toLowerCase()}`,
          kind: 'room',
          label: input.room.labelled ? label : `unnamed room ${label}`,
          ...(finite(input.self?.x) !== undefined && finite(input.self?.z) !== undefined
            ? { x: round(input.self?.x as number), z: round(input.self?.z as number) }
            : {}),
          waysOut: input.room.waysOut.map((way) => cleanLabel(way)).filter((way) => way.length > 0).slice(0, 8),
        }, at);
      }
    }
    for (const person of input.people) {
      const id = cleanId(person.id);
      if (!id) continue;
      const near = finite(person.x) !== undefined && finite(person.z) !== undefined
        ? nearestLandmark(notes, person.x as number, person.z as number)
        : notes.landmarks.find((landmark) => landmark.kind === 'room' && landmark.lastSeenAt === at)?.id;
      upsertEncounter(notes, {
        participantId: id,
        ...(person.contactId ? { contactId: person.contactId } : {}),
        ...(near ? { near } : {}),
        ...(finite(person.x) !== undefined && finite(person.z) !== undefined ? { x: round(person.x as number), z: round(person.z as number) } : {}),
      }, at);
    }
    notes.perceptions += 1;
    this.persist(notes, at);
  }

  observeMove(input: { world: string; from?: string; to: string; at: string }): void {
    if (!WORLD_NAME_PATTERN.test(input.world)) return;
    const to = cleanId(input.to);
    if (!to) return;
    const notes = this.get(input.world) ?? emptyNotes(input.world, input.at);
    upsertLandmark(notes, { id: `place:${to}`, kind: 'place', label: to }, input.at);
    const from = input.from ? cleanId(input.from) : '';
    if (from && from !== to) {
      const existing = notes.routes.find((route) => route.from === `place:${from}` && route.to === `place:${to}`);
      if (existing) {
        existing.lastAt = input.at;
        existing.count += 1;
      } else {
        notes.routes.push({ from: `place:${from}`, to: `place:${to}`, firstAt: input.at, lastAt: input.at, count: 1 });
        if (notes.routes.length > MAX_ROUTES) notes.routes.splice(0, notes.routes.length - MAX_ROUTES);
      }
    }
    this.persist(notes, input.at);
  }

  addNote(input: { world: string; text: string; about?: string }): WorldNote {
    if (!WORLD_NAME_PATTERN.test(input.world)) throw new Error('world must match the door world-name grammar');
    const text = input.text.replace(/\s+/gu, ' ').trim().slice(0, MAX_NOTE_CHARS);
    if (!text) throw new Error('note text is required');
    const at = this.now().toISOString();
    const notes = this.get(input.world) ?? emptyNotes(input.world, at);
    const note: WorldNote = {
      id: `note:${notes.notes.length + 1}-${at.slice(0, 19).replace(/[-:T]/gu, '')}`,
      text,
      ...(input.about ? { about: cleanId(input.about) } : {}),
      at,
    };
    notes.notes.push(note);
    if (notes.notes.length > MAX_NOTES) notes.notes.splice(0, notes.notes.length - MAX_NOTES);
    this.persist(notes, at);
    return note;
  }

  summarize(world: string): string {
    const notes = this.get(world);
    if (!notes) return '';
    const parts: string[] = [];
    const rooms = notes.landmarks.filter((landmark) => landmark.kind === 'room').slice(-6);
    const things = notes.landmarks.filter((landmark) => landmark.kind === 'thing').slice(-8);
    const places = notes.landmarks.filter((landmark) => landmark.kind === 'place').slice(-6);
    if (rooms.length > 0) parts.push(`rooms you have been in: ${rooms.map((room) => room.label).join(', ')}`);
    if (things.length > 0) {
      parts.push(`things you have seen: ${things.map((thing) => (
        thing.x !== undefined && thing.z !== undefined ? `${thing.label} at (${thing.x}, ${thing.z})` : thing.label
      )).join(', ')}`);
    }
    if (places.length > 0) parts.push(`places you have walked to: ${places.map((place) => place.label).join(', ')}`);
    if (notes.routes.length > 0) {
      parts.push(`routes you know: ${notes.routes.slice(-6).map((route) => `${strip(route.from)} → ${strip(route.to)}`).join(', ')}`);
    }
    if (notes.encounters.length > 0) {
      parts.push(`met here before: ${notes.encounters.slice(-6).map((encounter) => (
        encounter.near ? `${encounter.participantId} near ${strip(encounter.near)}` : encounter.participantId
      )).join(', ')}`);
    }
    if (notes.notes.length > 0) {
      parts.push(`your notes: ${notes.notes.slice(-3).map((note) => `"${note.text}"`).join(' ')}`);
    }
    return parts.join('; ');
  }

  private persist(notes: WorldNotes, at: string): void {
    notes.updatedAt = at;
    this.store.upsert({
      id: worldNotesDocId(notes.world),
      title: `World notes: ${notes.world}`,
      body: JSON.stringify(notes, null, 2),
      tags: [WORLD_NOTES_TAG, `world:${notes.world}`],
      sourceClass: 'generated_synthesis',
      // Runtime-derived from the world tool's own perceptions and moves; the
      // world plane is the source.
      provenanceRefs: [`world-plane:${notes.world}`],
      sensitivity: 'personal',
      summary: `${notes.landmarks.length} landmarks, ${notes.routes.length} routes, ${notes.encounters.length} encounters, ${notes.notes.length} notes`,
      updatedBy: 'agent:world-notes',
    });
  }
}

export function parseWorldNotesDocument(document: WikiDocument): WorldNotes | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(document.body);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.world !== 'string') return undefined;
  const list = <T>(value: unknown, keep: (entry: unknown) => entry is T): T[] => (
    Array.isArray(value) ? value.filter(keep) : []
  );
  return {
    schemaVersion: 1,
    world: raw.world,
    landmarks: list(raw.landmarks, (entry): entry is WorldLandmark => isRecord(entry) && typeof entry.id === 'string' && typeof entry.label === 'string'),
    routes: list(raw.routes, (entry): entry is WorldRouteLike => isRecord(entry) && typeof entry.from === 'string' && typeof entry.to === 'string'),
    encounters: list(raw.encounters, (entry): entry is WorldEncounter => isRecord(entry) && typeof entry.participantId === 'string'),
    notes: list(raw.notes, (entry): entry is WorldNote => isRecord(entry) && typeof entry.id === 'string' && typeof entry.text === 'string'),
    perceptions: typeof raw.perceptions === 'number' && Number.isFinite(raw.perceptions) ? raw.perceptions : 0,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : document.createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : document.updatedAt,
  };
}

type WorldRouteLike = WorldNotes['routes'][number];

function emptyNotes(world: string, at: string): WorldNotes {
  return { schemaVersion: 1, world, landmarks: [], routes: [], encounters: [], notes: [], perceptions: 0, createdAt: at, updatedAt: at };
}

function upsertLandmark(
  notes: WorldNotes,
  landmark: Omit<WorldLandmark, 'firstSeenAt' | 'lastSeenAt' | 'seenCount'>,
  at: string,
): void {
  const existing = notes.landmarks.find((candidate) => candidate.id === landmark.id);
  if (existing) {
    existing.label = landmark.label;
    if (landmark.x !== undefined && landmark.z !== undefined) { existing.x = landmark.x; existing.z = landmark.z; }
    if (landmark.waysOut) existing.waysOut = landmark.waysOut;
    if (landmark.detail) existing.detail = landmark.detail;
    existing.lastSeenAt = at;
    existing.seenCount += 1;
    return;
  }
  notes.landmarks.push({ ...landmark, firstSeenAt: at, lastSeenAt: at, seenCount: 1 });
  if (notes.landmarks.length > MAX_LANDMARKS) notes.landmarks.splice(0, notes.landmarks.length - MAX_LANDMARKS);
}

function upsertEncounter(
  notes: WorldNotes,
  encounter: Omit<WorldEncounter, 'firstAt' | 'lastAt' | 'count'>,
  at: string,
): void {
  const existing = notes.encounters.find((candidate) => candidate.participantId === encounter.participantId);
  if (existing) {
    if (encounter.contactId) existing.contactId = encounter.contactId;
    if (encounter.near) existing.near = encounter.near;
    if (encounter.x !== undefined && encounter.z !== undefined) { existing.x = encounter.x; existing.z = encounter.z; }
    existing.lastAt = at;
    existing.count += 1;
    return;
  }
  notes.encounters.push({ ...encounter, firstAt: at, lastAt: at, count: 1 });
  if (notes.encounters.length > MAX_ENCOUNTERS) notes.encounters.splice(0, notes.encounters.length - MAX_ENCOUNTERS);
}

function nearestLandmark(notes: WorldNotes, x: number, z: number): string | undefined {
  let best: { id: string; distance: number } | undefined;
  for (const landmark of notes.landmarks) {
    if (landmark.x === undefined || landmark.z === undefined) continue;
    const distance = Math.hypot(landmark.x - x, landmark.z - z);
    if (distance <= NEAR_LANDMARK_M && (!best || distance < best.distance)) best = { id: landmark.id, distance };
  }
  return best?.id;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function cleanId(value: string): string {
  return value.replace(/^@/u, '').replace(/[^A-Za-z0-9._:-]/gu, '').slice(0, 64);
}

function cleanLabel(value: string): string {
  return value.replace(/[\r\n<>]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_LABEL_CHARS);
}

function strip(ref: string): string {
  return ref.replace(/^(place|thing|room):/u, '');
}

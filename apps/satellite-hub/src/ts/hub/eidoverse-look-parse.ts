/**
 * Structured reading of the door's `look` text.
 *
 * The door renders perception as prose (see eidoverse-worlds `agent.ts`
 * `look()`): a header line with the body's own position, a `People (N):`
 * roster, a `Things (N):` roster, and an optional `Since you last looked:`
 * tail. The companion needs those facts as numbers to decide where to go, so
 * this parser lifts them out. Every line it does not recognise is kept verbatim
 * in `raw`; nothing is invented — a person whose position the door withholds
 * is reported with `positionKnown: false`, never with a guessed coordinate.
 */

export interface EidoverseLookSelf {
  id: string;
  world: string;
  positionKnown: boolean;
  x?: number;
  z?: number;
  groundHeightM?: number;
  facing?: string;
}

export interface EidoverseLookPerson {
  id: string;
  /** Set by the adapter from the world's classification; never by the parser. */
  kind?: "human" | "ai";
  kindSource?: "world" | "assumed";
  positionKnown: boolean;
  x?: number;
  z?: number;
  distanceM?: number;
  bearing?: string;
  doing?: string;
}

export interface EidoverseLookThing {
  id: string;
  label: string;
  positionKnown: boolean;
  x?: number;
  y?: number;
  z?: number;
  distanceM?: number;
  bearing?: string;
  detail?: string;
}

/**
 * The room the body stands in, when the door says so (a griddled `structure`
 * entity knows its rooms; open ground has none). The door's sentence:
 * `You are in the kitchen — 4×3m, 12m². Ways out: a door on its north to the
 * hall. (inside [ent-7]; sides are the building's own compass.)`. This is the
 * one named-place primitive the world itself provides (psfn-framework-gs899).
 */
export interface EidoverseLookRoom {
  /** The room's label, or its id when unlabelled. */
  label: string;
  labelled: boolean;
  widthM?: number;
  depthM?: number;
  areaM2?: number;
  /** The structure entity the room belongs to. */
  insideEntityId?: string;
  /** Door/window phrases as the door wrote them ("a door on its north to the hall"). */
  waysOut: string[];
  sealed: boolean;
}

/** Whatever the door's `World:` line carried that a map cares about. */
export interface EidoverseLookWorldInfo {
  terrain?: { sizeM?: number; flatRadiusM?: number; seed?: number };
  raw: Record<string, unknown>;
}

export interface EidoverseLookPerception {
  self: EidoverseLookSelf | null;
  /** Present only when the body stands inside a room the door can name. */
  room?: EidoverseLookRoom;
  /** Present only when the door printed a parseable `World:` line. */
  worldInfo?: EidoverseLookWorldInfo;
  people: EidoverseLookPerson[];
  things: EidoverseLookThing[];
  /** Lines the door reported under "Since you last looked:", speaker-prefixed. */
  recent: string[];
  raw: string;
}

const SELF_KNOWN = /^You are "([^"]+)" in world "([^"]+)" at \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\), ground height (-?\d+(?:\.\d+)?)m, facing ([A-Z]{1,2})/u;
const SELF_UNKNOWN = /^You are "([^"]+)" in world "([^"]+)", position unknown/u;
const SELF_FACING = /facing ([A-Z]{1,2})/u;
const PERSON_KNOWN = /^-\s+([^:\s]+):\s+(?:(-?\d+(?:\.\d+)?)m ([A-Z]{1,2}) )?at \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)(?:,\s*(.*))?$/u;
const PERSON_UNKNOWN = /^-\s+([^\s(]+)\s*\((.*)\)$/u;
const THING_KNOWN = /^-\s+\[([^\]]+)\]\s+([^:]*):\s+(?:(-?\d+(?:\.\d+)?)m ([A-Z]{1,2}) )?at \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)(.*)$/u;
const THING_UNKNOWN = /^-\s+\[([^\]]+)\]\s+([^:]*):\s+(.*)$/u;

const ROOM_LINE = /^You are in (?:the (.+?)|an unnamed room \(([^)]+)\)) — (\d+)×(\d+)m, (\d+(?:\.\d+)?)m²\.(.*)$/u;
const ROOM_INSIDE = /\(inside \[([^\]]+)\];/u;
const ROOM_WAYS = /Ways out: (.+?)\./u;

type Section = "header" | "people" | "things" | "recent";

export function parseEidoverseLook(text: string): EidoverseLookPerception {
  const perception: EidoverseLookPerception = { self: null, people: [], things: [], recent: [], raw: text };
  let section: Section = "header";
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^People \(\d+\):$/u.test(line)) { section = "people"; continue; }
    if (/^Nobody else is here right now\.$/u.test(line)) { section = "people"; continue; }
    if (/^Things \(\d+\):$/u.test(line)) { section = "things"; continue; }
    if (/^No placed things yet\.$/u.test(line)) { section = "things"; continue; }
    if (/^Since you last looked:$/u.test(line)) { section = "recent"; continue; }

    if (section === "header") {
      const self = parseSelf(line);
      if (self) { perception.self = self; continue; }
      const room = parseRoom(line);
      if (room) { perception.room = room; continue; }
      const worldInfo = parseWorldInfo(line);
      if (worldInfo) perception.worldInfo = worldInfo;
      continue;
    }
    if (section === "people") {
      const person = parsePerson(line);
      if (person) perception.people.push(person);
      continue;
    }
    if (section === "things") {
      const thing = parseThing(line);
      if (thing) perception.things.push(thing);
      continue;
    }
    perception.recent.push(line);
  }
  return perception;
}

function parseSelf(line: string): EidoverseLookSelf | null {
  const known = SELF_KNOWN.exec(line);
  if (known) {
    return {
      id: known[1]!,
      world: known[2]!,
      positionKnown: true,
      x: Number(known[3]),
      z: Number(known[4]),
      groundHeightM: Number(known[5]),
      facing: known[6]!,
    };
  }
  const unknown = SELF_UNKNOWN.exec(line);
  if (unknown) {
    const facing = SELF_FACING.exec(line)?.[1];
    return { id: unknown[1]!, world: unknown[2]!, positionKnown: false, ...(facing ? { facing } : {}) };
  }
  return null;
}

function parseRoom(line: string): EidoverseLookRoom | null {
  const match = ROOM_LINE.exec(line);
  if (!match) return null;
  const tail = match[6] ?? "";
  const ways = ROOM_WAYS.exec(tail)?.[1];
  const inside = ROOM_INSIDE.exec(tail)?.[1];
  const labelled = match[1] !== undefined;
  return {
    label: (labelled ? match[1] : match[2]) ?? "",
    labelled,
    widthM: Number(match[3]),
    depthM: Number(match[4]),
    areaM2: Number(match[5]),
    ...(inside ? { insideEntityId: inside } : {}),
    waysOut: ways ? ways.split(/;\s*/u).map((way) => way.trim()).filter(Boolean) : [],
    sealed: /No doors — this room is sealed\./u.test(tail),
  };
}

function parseWorldInfo(line: string): EidoverseLookWorldInfo | null {
  if (!line.startsWith("World: ")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice("World: ".length));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const terrainRaw = record.terrain;
  const terrain: EidoverseLookWorldInfo["terrain"] = {};
  if (terrainRaw && typeof terrainRaw === "object" && !Array.isArray(terrainRaw)) {
    const t = terrainRaw as Record<string, unknown>;
    if (typeof t.size === "number" && Number.isFinite(t.size)) terrain.sizeM = t.size;
    if (typeof t.flatRadius === "number" && Number.isFinite(t.flatRadius)) terrain.flatRadiusM = t.flatRadius;
    if (typeof t.seed === "number" && Number.isFinite(t.seed)) terrain.seed = t.seed;
  }
  return { ...(Object.keys(terrain).length > 0 ? { terrain } : {}), raw: record };
}

function parsePerson(line: string): EidoverseLookPerson | null {
  const known = PERSON_KNOWN.exec(line);
  if (known) {
    const doing = known[6]?.trim();
    return {
      id: known[1]!,
      positionKnown: true,
      ...(known[2] !== undefined ? { distanceM: Number(known[2]) } : {}),
      ...(known[3] !== undefined ? { bearing: known[3] } : {}),
      x: Number(known[4]),
      z: Number(known[5]),
      ...(doing ? { doing } : {}),
    };
  }
  const unknown = PERSON_UNKNOWN.exec(line);
  if (unknown) {
    return { id: unknown[1]!, positionKnown: false, doing: unknown[2]!.trim() };
  }
  return null;
}

function parseThing(line: string): EidoverseLookThing | null {
  const known = THING_KNOWN.exec(line);
  if (known) {
    const detail = known[8]?.replace(/^\s*(?:\(elevated\))?\s*(?:—\s*)?/u, "").trim();
    return {
      id: known[1]!,
      label: known[2]!.trim(),
      positionKnown: true,
      ...(known[3] !== undefined ? { distanceM: Number(known[3]) } : {}),
      ...(known[4] !== undefined ? { bearing: known[4] } : {}),
      x: Number(known[5]),
      y: Number(known[6]),
      z: Number(known[7]),
      ...(detail ? { detail } : {}),
    };
  }
  const unknown = THING_UNKNOWN.exec(line);
  if (unknown) {
    return { id: unknown[1]!, label: unknown[2]!.trim(), positionKnown: false, detail: unknown[3]!.trim() };
  }
  return null;
}

/**
 * Find one person in a perception by id, case-insensitively and tolerant of a
 * leading `@`: the wire renders speakers by id, and a companion asked to
 * "walk to @Visitor" must find `visitor`.
 */
export function findEidoversePerson(
  perception: Pick<EidoverseLookPerception, "people">,
  participant: string,
): EidoverseLookPerson | undefined {
  const wanted = participant.trim().replace(/^@/u, "").toLowerCase();
  if (!wanted) return undefined;
  return perception.people.find((person) => person.id.toLowerCase() === wanted);
}

/**
 * Where to stand to be "with" someone: `standoffM` short of them along the
 * line from the body to them, so the walk ends beside the person rather than
 * on top of them. Already within the standoff ⇒ no destination (stay put).
 */
export function approachPosition(
  self: { x: number; z: number },
  target: { x: number; z: number },
  standoffM = 1.5,
): { x: number; z: number } | null {
  const dx = target.x - self.x;
  const dz = target.z - self.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= standoffM) return null;
  const scale = (distance - standoffM) / distance;
  return {
    x: Number((self.x + dx * scale).toFixed(2)),
    z: Number((self.z + dz * scale).toFixed(2)),
  };
}

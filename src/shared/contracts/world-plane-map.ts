// ── World-plane map cache (S13, psfn-framework-gs899 / g8xyn) ──
//
// The places registry is boot-time immutable and owns place identity. What
// the world itself publishes at runtime (the Hub's mapped places for the
// world, the room the body stands in, the terrain extent, the door's
// advertised tools) is remembered here per world, refreshed by every world
// tool round trip, and read by the world-plane situated block. Nothing here is
// authority: `tools` is advisory (the gateway's verb allowlist decides what the
// body may do) and a hub-published place that is absent from places.json is
// reachable by `move` but never written into the registry.

import type { WorldAvatarMap, WorldAvatarRoom } from './world-avatar.js';

export interface WorldPlaneMapSnapshot {
  world: string;
  /** The world's default place in the Hub's place map, when mapped. */
  placeId?: string;
  places: ReadonlyArray<{ placeId: string; region?: string }>;
  room?: WorldAvatarRoom;
  terrain?: { sizeM?: number; flatRadiusM?: number };
  tools: ReadonlyArray<{ name: string; description?: string }>;
  capturedAt: string;
}

export interface WorldPlaneMapReader {
  get(world: string): WorldPlaneMapSnapshot | undefined;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_WORLDS = 32;
const MAX_PLACES = 128;
const MAX_TOOLS = 64;
const WORLD_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/u;

export class WorldPlaneMapCache implements WorldPlaneMapReader {
  private readonly entries = new Map<string, { snapshot: WorldPlaneMapSnapshot; storedAt: number }>();

  constructor(
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}

  /** Remember a map the Hub published; bounded and overwriting per world. */
  remember(map: WorldAvatarMap): WorldPlaneMapSnapshot | undefined {
    if (!WORLD_NAME_PATTERN.test(map.world)) return undefined;
    const snapshot: WorldPlaneMapSnapshot = {
      world: map.world,
      ...(map.placeId ? { placeId: map.placeId } : {}),
      places: map.places.slice(0, MAX_PLACES).map((place) => ({
        placeId: place.placeId,
        ...(place.region ? { region: place.region } : {}),
      })),
      ...(map.room ? { room: map.room } : {}),
      ...(map.terrain ? { terrain: map.terrain } : {}),
      tools: map.tools.slice(0, MAX_TOOLS).map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
      })),
      capturedAt: map.capturedAt,
    };
    this.store(snapshot);
    return snapshot;
  }

  /**
   * A perception carries the room the body stands in; fold it into the
   * remembered map without disturbing the rest (absent room ⇒ open ground).
   */
  rememberRoom(world: string, room: WorldAvatarRoom | undefined, capturedAt: string): void {
    const current = this.get(world);
    if (!current) {
      if (!room || !WORLD_NAME_PATTERN.test(world)) return;
      this.store({ world, places: [], tools: [], room, capturedAt });
      return;
    }
    const { room: _previous, ...rest } = current;
    this.store({ ...rest, ...(room ? { room } : {}), capturedAt });
  }

  get(world: string): WorldPlaneMapSnapshot | undefined {
    const entry = this.entries.get(world);
    if (!entry) return undefined;
    const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.now() - entry.storedAt > ttl) {
      this.entries.delete(world);
      return undefined;
    }
    return entry.snapshot;
  }

  /** A hub-published place for `placeId`, when some remembered world lists it. */
  findPlace(placeId: string): { world: string; placeId: string; region?: string } | undefined {
    for (const world of this.entries.keys()) {
      const snapshot = this.get(world);
      const place = snapshot?.places.find((candidate) => candidate.placeId === placeId);
      if (place) return { world, ...place };
    }
    return undefined;
  }

  private store(snapshot: WorldPlaneMapSnapshot): void {
    if (!this.entries.has(snapshot.world) && this.entries.size >= MAX_WORLDS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(snapshot.world);
    this.entries.set(snapshot.world, { snapshot, storedAt: this.now() });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

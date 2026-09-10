import { createHash } from "node:crypto";

import type { PsfnSatelliteClaimConfig } from "./satellite-claim.js";
import { defaultCapabilitiesForProfile } from "./satellite-claim.js";
import {
  resolveEidoversePlace,
  type EidoversePlaceMap,
  type EidoversePlaceResolution,
} from "./eidoverse-place-map.js";
import {
  type EidoverseSpeaker,
  type EidoverseSpeakerKind,
  type EmbodiedSessionRegistry,
  type PsfnChannelContext,
  type SatelliteAttachmentOwnership,
  type VisionCaptureImage,
} from "./embodied-session.js";
import {
  EidoverseBodyActionRejectedError,
  parseEidoverseBodyAction,
  type EidoverseBodyRunResult,
  type EidoverseBodyRunner,
} from "./eidoverse-body-runner.js";
import {
  approachPosition,
  findEidoversePerson,
  parseEidoverseLook,
  type EidoverseLookPerception,
} from "./eidoverse-look-parse.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { findEnrolledEmanation } from "./device-registry.js";
import type { HubDeviceEnrollmentBinding, HubDeviceRegistryAuthority } from "./device-registry.js";
import { EIDOVERSE_SAY_MAX_TEXT_LENGTH } from "./eidoverse-mcp.js";
import type { SessionStore } from "./session-store.js";

const MAX_EIDOVERSE_CONTEXT_NOTES = 12;
/** How long the companion's own `move` waits for the body to arrive before
 *  answering "walking" and letting the outcome reach a later turn. Must fit
 *  inside the gateway's per-request budget with room for a travel round trip. */
const DEFAULT_MOVE_WAIT_MS = 6_000;
const DEFAULT_ACT_WAIT_MS = 4_000;

/**
 * The door's own world-name grammar. Checked here so a malformed destination is
 * refused before it reaches the wire, and so a refusal never depends on parsing
 * the door's prose back out of a tool result.
 */
const EIDOVERSE_WORLD_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/u;

export interface EidoverseEmbodiedSessionConfig {
  worldName: string;
  agentName: string;
  satelliteClaim: PsfnSatelliteClaimConfig;
  placeMap: EidoversePlaceMap | null;
}

export interface EidoverseAddressedUtterance {
  utteranceId: string;
  userText: string;
  region?: string;
  /** Who spoke, with the world's human/ai classification. */
  speaker?: EidoverseSpeaker;
}

export interface EidoverseLookSource {
  look(): Promise<string>;
  /** Optional: the door's advertised tool list (`tools/list`). */
  listTools?(): Promise<Array<{ name: string; description?: string }>>;
}

export interface EidoverseSayPublisher {
  say(text: string): Promise<void>;
}

/**
 * Optional first-person vision. `capture` resolves to null whenever the world's
 * renderer is absent, slow, or refusing — the turn then keeps only its text
 * `look()` notes.
 */
export interface EidoverseSnapshotCaptureSource {
  capture(sessionId: string, world: string, view?: "first" | "third" | "selfie"): Promise<VisionCaptureImage | null>;
}

/**
 * The companion's own snapshot on request (psfn-framework-mlhfw): the door's
 * first/third/selfie view as a bounded PNG, or an honest "not available".
 */
export type EidoverseAvatarSnapshot =
  | { available: true; world: string; view: "first" | "third" | "selfie"; mimeType: string; dataBase64: string; bytes: number; capturedAt: string }
  | { available: false; world: string; view: "first" | "third" | "selfie"; reason: "not_configured" | "unavailable" };

/**
 * The world-to-world move. Resolves with the door's arrival text and rejects on
 * refusal, timeout, or a dropped connection — the tool call's own return is the
 * arrival signal, so there is nothing else to wait for.
 */
export interface EidoverseTravelPort {
  travel(world: string): Promise<string>;
}

/** Why a travel attempt did not move the body. Never carries door text. */
export type EidoverseTravelRefusal =
  | "unavailable"
  | "invalid_world"
  | "unmapped_world"
  | "refused";

export type EidoverseTravelOutcome =
  | { accepted: true; world: string; placeId?: string }
  | { accepted: false; world: string; reason: EidoverseTravelRefusal };

export interface EidoverseEmbodiedSessionLogger {
  warn(message: string): void;
  info?(message: string): void;
}

/** The companion's own reading of the world it has a body in. */
export interface EidoverseAvatarPerception extends EidoverseLookPerception {
  world: string;
  placeId?: string;
  region?: string;
  capturedAt: string;
}

/**
 * The world's map as the Hub can honestly publish it (psfn-framework-gs899):
 * the places the Hub's place map binds to this world, the room the body
 * stands in (the door's one named-place primitive), the terrain extent, and
 * the door's advertised tools (psfn-framework-g8xyn). Nothing is invented:
 * the door has no region model, so `places` is the operator's mapping and
 * `room` only appears when the body is inside a structure.
 */
export interface EidoverseWorldMap {
  world: string;
  /** The world's default place in the Hub's place map, when mapped. */
  placeId?: string;
  places: Array<{ placeId: string; region?: string }>;
  room?: EidoverseLookPerception["room"];
  terrain?: { sizeM?: number; flatRadiusM?: number };
  tools: Array<{ name: string; description?: string }>;
  capturedAt: string;
}

export interface EidoverseAvatarMoveRequest {
  /** Destination world; omitted or equal to the current world ⇒ no travel. */
  world?: string;
  /** Door region label the destination belongs to (place-map key). */
  region?: string;
  /** Where to stand, in the destination world's ground plane. */
  position?: { x: number; z: number };
  /** Walk to this participant's current position instead (id, `@` tolerated). */
  participant?: string;
  /** Bounded wait for arrival before answering. */
  waitMs?: number;
}

/**
 * `no_position`: the move named a region the place map binds to a place but
 * carried no coordinates and no participant, so there was nowhere to walk;
 * the region is remembered and the body did not move (psfn-framework-zsoo8).
 */
export type EidoverseAvatarWalkStatus =
  | "arrived"
  | "walking"
  | "interrupted"
  | "failed"
  | "already_there"
  | "no_position";

export type EidoverseAvatarMoveOutcome =
  | {
    accepted: true;
    world: string;
    placeId?: string;
    walk?: { status: EidoverseAvatarWalkStatus; x?: number; z?: number; target?: { x: number; z: number } };
  }
  | {
    accepted: false;
    world: string;
    reason: EidoverseTravelRefusal | "not_configured" | "participant_unknown" | "participant_position_unknown" | "position_unknown";
  };

export type EidoverseAvatarActOutcome =
  | { accepted: true; verb: string; outcome: EidoverseBodyRunResult["outcome"] | "pending"; reply: string | null }
  | { accepted: false; verb: string; reason: "not_configured" | "not_allowlisted" | "unavailable" };

export interface EidoverseEmbodiedSessionDependencies {
  embodiedSessions: EmbodiedSessionRegistry;
  sessions: SessionStore;
  agent: FrameworkAgentAdapter;
  look: EidoverseLookSource;
  onLookError?: () => void;
  say: EidoverseSayPublisher;
  /**
   * Allowlisted locomotion. Present only when the claim profile grants the
   * `avatar_action` capability; absent, body requests fail closed.
   */
  body?: EidoverseBodyRunner;
  /**
   * Present only when snapshots are explicitly enabled and the claim profile
   * grants the vision capability.
   */
  snapshot?: EidoverseSnapshotCaptureSource;
  /** Present only on transports that can move between worlds (MCPL). */
  travel?: EidoverseTravelPort;
  /**
   * The Hub device registry, present only when the Hub can also sign device
   * assertions. When the registry enrolls this world emanation (same
   * satellite, endpoint and `world-avatar` claim type), every wake turn
   * carries a Hub device assertion bound to the enrollment place, so the
   * gateway treats the world channel as a registered surface instead of an
   * anonymous caller on the hub port (psfn-framework-rqm6t).
   */
  emanationRegistry?: HubDeviceRegistryAuthority;
  logger?: EidoverseEmbodiedSessionLogger;
}

/**
 * Protocol-neutral embodiment seam for an Eidoverse visitor. The wake source
 * supplies addressed utterances; this adapter owns session continuity,
 * deduplication, the single FrameworkAgentAdapter call, and the resulting
 * allowlisted in-world `say` publication for each utterance.
 */
export class EidoverseEmbodiedSessionAdapter {
  readonly conversationId: string;

  private readonly worldName: string;
  /**
   * The world the body is in right now. Travel moves it; the conversation id
   * stays anchored to the world the session was founded in, because the door
   * carries identity across a move and the resident is one continuous
   * conversation, not one per island.
   */
  private currentWorldName: string;
  /**
   * One-shot: set when travel lands the body somewhere new and consumed by the
   * first turn that carries it. See `channelContext`.
   */
  private arrivalNote: { key: string; text: string } | null = null;
  /**
   * The region the body last walked to on purpose. The MCPL wake path never
   * carries a region, so without this the turn after a deliberate walk to the
   * plaza would resolve the world's default place and quietly undo the move.
   * Cleared by travel and by a door resync.
   */
  private currentRegion: string | undefined;
  /**
   * Who is human and who is an AI, as the WORLD says (the door tags
   * agent-authored chat `chat:from-agent`; untagged chat is a human). The
   * roster feeds perception and the standing note. Anyone the world has not
   * classified is assumed an AI (operator rule).
   */
  private readonly participantKinds = new Map<string, EidoverseSpeakerKind>();
  private readonly consumedUtteranceIds = new Set<string>();
  private readonly activeReplies = new Set<AbortController>();
  private attachmentOwnership: SatelliteAttachmentOwnership | null = null;

  constructor(
    private readonly config: EidoverseEmbodiedSessionConfig,
    private readonly deps: EidoverseEmbodiedSessionDependencies,
  ) {
    this.worldName = requireNonEmpty(config.worldName, "Eidoverse world name");
    this.currentWorldName = this.worldName;
    requireNonEmpty(config.agentName, "Eidoverse agent name");
    if (
      config.satelliteClaim.capabilityProfile !== "world-avatar"
      || config.satelliteClaim.type !== "world-avatar"
    ) {
      throw new Error("Eidoverse embodied sessions require the world-avatar capability profile and claim type");
    }
    this.conversationId = stableConversationId(
      this.worldName,
      config.satelliteClaim.satelliteId,
    );
  }

  connect(): void {
    if (this.attachmentOwnership) return;
    const claim = this.config.satelliteClaim;
    const deviceAuthority = this.resolveEmanationDeviceAuthority();
    const attachment = this.deps.embodiedSessions.attachSatellite({
      sessionId: this.conversationId,
      satelliteId: claim.satelliteId,
      satelliteName: claim.displayName,
      transport: "mcp",
      capabilities: defaultCapabilitiesForProfile("world-avatar"),
      claimIdentity: {
        satelliteId: claim.satelliteId,
        endpointId: claim.endpointId,
        claimType: claim.type,
        displayName: claim.displayName,
      },
      ...(deviceAuthority ? { deviceAuthority } : {}),
    });
    this.attachmentOwnership = attachment.ownership;
    this.deps.sessions.touch(this.conversationId);
  }

  /**
   * The emanation's own enrollment, read from the registry at attach time.
   * Absent registry: today's anonymous world channel. Registry without a
   * matching active entry: one warning, still anonymous, never a guess.
   */
  private resolveEmanationDeviceAuthority(): HubDeviceEnrollmentBinding | null {
    const registry = this.deps.emanationRegistry;
    if (!registry) return null;
    const claim = this.config.satelliteClaim;
    const binding = findEnrolledEmanation(registry.readCurrent(), {
      satelliteId: claim.satelliteId,
      endpointId: claim.endpointId,
      claimType: claim.type,
    });
    if (!binding) {
      (this.deps.logger ?? console).warn(
        `Eidoverse world emanation "${claim.satelliteId}/${claim.endpointId}" has no active Hub device enrollment; wake turns carry no device assertion`,
      );
      return null;
    }
    this.log(
      `Eidoverse world emanation enrolled as Hub device "${binding.deviceId}" (v${binding.enrollmentVersion}, place ${binding.placeId ?? "unbound"})`,
    );
    return binding;
  }

  disconnect(): void {
    const ownership = this.attachmentOwnership;
    this.attachmentOwnership = null;
    for (const controller of this.activeReplies) {
      controller.abort(new DOMException("Eidoverse embodiment disconnected", "AbortError"));
    }
    this.activeReplies.clear();
    if (ownership) {
      this.deps.embodiedSessions.detachSatellite(
        this.conversationId,
        this.config.satelliteClaim.satelliteId,
        ownership,
      );
    }
  }

  /**
   * Accepts an allowlisted body action and starts it off the turn's critical
   * path. Locomotion can block for the door's full walk budget, so nothing here
   * is awaited; the outcome reaches the companion as a content-free context
   * note on a later turn. An unallowlisted verb or a profile without the
   * `avatar_action` capability is rejected before the door is touched.
   */
  submitBodyAction(name: string, args: unknown = {}): void {
    const body = this.deps.body;
    if (!body) {
      throw new Error("Eidoverse body actions are not enabled for this capability profile");
    }
    body.submit(parseEidoverseBodyAction(name, args));
  }

  /** The world the body is in right now, as the Hub believes it. */
  currentWorld(): string {
    return this.currentWorldName;
  }

  /** Record the world's classification of one participant (see `participantKinds`). */
  observeParticipant(id: string, kind: EidoverseSpeakerKind): void {
    const key = id.trim().toLowerCase();
    if (key) this.participantKinds.set(key, kind);
  }

  /** The world's classification of a participant, or the assumed default. */
  participantKind(id: string): { kind: EidoverseSpeakerKind; kindSource: "world" | "assumed" } {
    const known = this.participantKinds.get(id.trim().toLowerCase());
    return known ? { kind: known, kindSource: "world" } : { kind: "ai", kindSource: "assumed" };
  }

  /**
   * The companion's own look: the door's prose lifted into positions the
   * model can reason about, plus the place the Hub maps the body to.
   */
  async perceive(): Promise<EidoverseAvatarPerception> {
    this.requireConnection();
    const parsed = parseEidoverseLook(await this.deps.look.look());
    const place = this.resolvePlace(this.currentRegion);
    return {
      ...parsed,
      people: parsed.people.map((person) => ({ ...person, ...this.participantKind(person.id) })),
      world: this.currentWorldName,
      ...(place.placeId ? { placeId: place.placeId } : {}),
      ...(this.currentRegion ? { region: this.currentRegion } : {}),
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * The world's map for the companion's world-plane turn: one look for the
   * room and terrain, the Hub's place map for this world, and the door's tool
   * list when the transport can ask for it. Bounded and best-effort: a door
   * that cannot list tools yields an empty list, never a failure.
   */
  async map(): Promise<EidoverseWorldMap> {
    this.requireConnection();
    const parsed = parseEidoverseLook(await this.deps.look.look());
    const world = this.currentWorldName;
    const mapping = this.config.placeMap?.worlds[world];
    const places: EidoverseWorldMap["places"] = [];
    if (mapping) {
      places.push({ placeId: mapping.placeId });
      for (const [region, placeId] of Object.entries(mapping.regions)) {
        if (placeId !== mapping.placeId || region) places.push({ placeId, region });
      }
    }
    let tools: EidoverseWorldMap["tools"] = [];
    if (this.deps.look.listTools) {
      try {
        tools = await this.deps.look.listTools();
      } catch {
        tools = [];
      }
    }
    const terrain = parsed.worldInfo?.terrain;
    return {
      world,
      ...(mapping ? { placeId: mapping.placeId } : {}),
      places,
      ...(parsed.room ? { room: parsed.room } : {}),
      ...(terrain && (terrain.sizeM !== undefined || terrain.flatRadiusM !== undefined)
        ? { terrain: { ...(terrain.sizeM !== undefined ? { sizeM: terrain.sizeM } : {}), ...(terrain.flatRadiusM !== undefined ? { flatRadiusM: terrain.flatRadiusM } : {}) } }
        : {}),
      tools,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * The companion-initiated move: travel when the destination is another
   * world, then walk when there is somewhere to stand. Waits a bounded time
   * for arrival so a short walk answers on the same turn; a longer one answers
   * "walking" and its outcome becomes a later turn's note. Nothing here needs
   * a Hub device: the companion is moving its own body.
   */
  async moveTo(input: EidoverseAvatarMoveRequest): Promise<EidoverseAvatarMoveOutcome> {
    this.requireConnection();
    const destinationWorld = input.world?.trim();
    if (destinationWorld && destinationWorld !== this.currentWorldName) {
      const travelled = await this.travelTo(destinationWorld);
      if (!travelled.accepted) return travelled;
    }
    const region = normalizeOptional(input.region);
    let target = input.position ? { x: input.position.x, z: input.position.z } : null;
    if (!target && input.participant) {
      const perception = parseEidoverseLook(await this.deps.look.look());
      const person = findEidoversePerson(perception, input.participant);
      if (!person) return this.refuseMove("participant_unknown");
      if (!person.positionKnown || person.x === undefined || person.z === undefined) {
        return this.refuseMove("participant_position_unknown");
      }
      const self = perception.self;
      if (!self?.positionKnown || self.x === undefined || self.z === undefined) {
        return this.refuseMove("position_unknown");
      }
      const approach = approachPosition({ x: self.x, z: self.z }, { x: person.x, z: person.z });
      if (!approach) {
        this.currentRegion = region;
        return {
          accepted: true,
          world: this.currentWorldName,
          ...this.placeIdFor(this.currentWorldName, region),
          walk: { status: "already_there", x: self.x, z: self.z, target: { x: person.x, z: person.z } },
        };
      }
      target = approach;
    }
    if (!target) {
      // Travel-only (or a no-op move to the world the body is already in).
      this.currentRegion = region;
      if (region) {
        // The place map binds regions to places, not coordinates: a bare
        // region cannot be walked to. Say so instead of answering a silent
        // accept (psfn-framework-zsoo8).
        this.log(`Eidoverse body walk_to skipped: region "${region}" in world "${this.currentWorldName}" has no position`);
        return {
          accepted: true,
          world: this.currentWorldName,
          ...this.placeIdFor(this.currentWorldName, region),
          walk: { status: "no_position" },
        };
      }
      return { accepted: true, world: this.currentWorldName, ...this.placeIdFor(this.currentWorldName, region) };
    }
    if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) {
      return this.refuseMove("position_unknown");
    }
    const body = this.deps.body;
    if (!body) return this.refuseMove("not_configured");
    const run = body.start({ name: "walk_to", x: target.x, z: target.z, run: false });
    const result = await withBoundedWait(run, input.waitMs ?? DEFAULT_MOVE_WAIT_MS);
    if (result === "pending") {
      body.noteWhenDone(run);
      this.currentRegion = region;
      this.log(`Eidoverse body walk_to (${target.x}, ${target.z}) in world "${this.currentWorldName}" still walking after bounded wait`);
      // The deferred completion is also the only proof a long walk ended;
      // log it the same way a walk that fit the wait is logged
      // (psfn-framework-f5vd8).
      const world = this.currentWorldName;
      void run.then((settled) => {
        this.log(this.describeWalkResult(settled, world));
      }).catch(() => undefined);
      return {
        accepted: true,
        world: this.currentWorldName,
        ...this.placeIdFor(this.currentWorldName, region),
        walk: { status: "walking", target },
      };
    }
    const status: EidoverseAvatarWalkStatus = result.outcome === "arrived"
      ? "arrived"
      : result.outcome === "interrupted-or-timed-out" ? "interrupted" : "failed";
    if (status === "arrived") this.currentRegion = region;
    const position = result.position;
    this.log(this.describeWalkResult(result, this.currentWorldName));
    return {
      accepted: true,
      world: this.currentWorldName,
      ...this.placeIdFor(this.currentWorldName, status === "arrived" ? region : this.currentRegion),
      walk: { status, ...(position ?? {}), target },
    };
  }

  /**
   * One body or creation verb on the companion's own initiative, awaited for a
   * bounded time. The allowlist and argument shapes are the body runner's; a
   * verb the transport cannot reach answers `unavailable`, never a guess.
   */
  async act(verb: string, args: unknown = {}, waitMs = DEFAULT_ACT_WAIT_MS): Promise<EidoverseAvatarActOutcome> {
    this.requireConnection();
    const body = this.deps.body;
    if (!body) return { accepted: false, verb, reason: "not_configured" };
    let run: Promise<EidoverseBodyRunResult>;
    try {
      run = body.start(parseEidoverseBodyAction(verb, args));
    } catch (error) {
      if (error instanceof EidoverseBodyActionRejectedError) {
        return { accepted: false, verb, reason: "not_allowlisted" };
      }
      return { accepted: false, verb, reason: "unavailable" };
    }
    const result = await withBoundedWait(run, waitMs);
    if (result === "pending") {
      body.noteWhenDone(run);
      return { accepted: true, verb, outcome: "pending", reply: null };
    }
    this.log(`Eidoverse body ${verb} ${result.outcome} in world "${this.currentWorldName}"`);
    return { accepted: true, verb, outcome: result.outcome, reply: result.reply };
  }

  /** One info line per settled walk, whether it fit the bounded wait or not. */
  private describeWalkResult(result: EidoverseBodyRunResult, world: string): string {
    const status: EidoverseAvatarWalkStatus = result.outcome === "arrived"
      ? "arrived"
      : result.outcome === "interrupted-or-timed-out" ? "interrupted" : "failed";
    const position = result.position;
    return `Eidoverse body walk_to ${status}${position ? ` at (${position.x}, ${position.z})` : ""} in world "${world}"`;
  }

  private refuseMove(
    reason: Extract<EidoverseAvatarMoveOutcome, { accepted: false }>["reason"],
  ): EidoverseAvatarMoveOutcome {
    (this.deps.logger ?? console).warn(`Eidoverse move refused: ${reason}`);
    return { accepted: false, world: this.currentWorldName, reason };
  }

  private log(message: string): void {
    const logger = this.deps.logger;
    if (logger?.info) logger.info(message);
    else if (!logger) console.info(message);
  }

  async handleAddressedUtterance(input: EidoverseAddressedUtterance): Promise<string | null> {
    const ownership = this.requireConnection();
    const utteranceId = requireNonEmpty(input.utteranceId, "Eidoverse utterance ID");
    const userText = requireNonEmpty(input.userText, "Eidoverse addressed utterance text");
    if (this.consumedUtteranceIds.has(utteranceId)) return null;
    this.consumedUtteranceIds.add(utteranceId);

    // Vision runs alongside the text look rather than after it: the door's
    // renderer can take seconds, and neither call may serialize behind the
    // other on the turn's critical path.
    const [lookNotes, capture] = await Promise.all([
      this.lookContextNotes(),
      this.captureSnapshot(),
    ]);
    const channel = this.channelContext(input.region, ownership, lookNotes, capture, input.speaker);
    const controller = new AbortController();
    this.activeReplies.add(controller);
    this.deps.sessions.append(this.conversationId, { role: "user", content: userText });
    try {
      let responseText = "";
      const stream = this.deps.agent.streamReply({
        inputMode: "text",
        userText,
        conversationId: this.conversationId,
        history: this.deps.sessions.getHistory(this.conversationId),
        channel,
        signal: controller.signal,
      });
      for await (const delta of stream) {
        responseText += delta;
      }
      responseText = responseText.trim();
      if (responseText) {
        this.deps.sessions.append(this.conversationId, { role: "assistant", content: responseText });
        await this.publishReply(responseText);
      }
      return responseText;
    } finally {
      this.activeReplies.delete(controller);
    }
  }

  /**
   * Move the body to another world and re-situate the turn.
   *
   * The place map is consulted BEFORE the wire, not after: an unmapped
   * destination is refused where the body still is, so there is never a moment
   * where the companion is somewhere the Hub cannot name. Nothing here invents
   * a place — an unmapped world does not get a fabricated ID, it gets a
   * refusal, and the previous placeId keeps standing.
   *
   * Every failure path is the same shape: the world is unchanged, the outcome
   * says why in a fixed vocabulary, and the log line carries no door text.
   */
  async travelTo(world: string): Promise<EidoverseTravelOutcome> {
    this.requireConnection();
    const destination = world.trim();
    if (!EIDOVERSE_WORLD_NAME_PATTERN.test(destination)) {
      return this.refuseTravel("invalid_world");
    }
    const port = this.deps.travel;
    if (!port) return this.refuseTravel("unavailable");
    if (destination === this.currentWorldName) {
      return { accepted: true, world: destination, ...this.placeIdFor(destination) };
    }
    const destinationPlace = this.config.placeMap
      ? resolveEidoversePlace(this.config.placeMap, destination)
      : null;
    if (destinationPlace && !destinationPlace.placeId) {
      return this.refuseTravel("unmapped_world");
    }
    try {
      await port.travel(destination);
    } catch {
      return this.refuseTravel("refused");
    }
    this.currentWorldName = destination;
    this.currentRegion = undefined;
    this.arrivalNote = {
      key: "eidoverse.travel",
      text: `You travelled to the Eidoverse world ${JSON.stringify(destination)}.`,
    };
    return { accepted: true, world: destination, ...this.placeIdFor(destination) };
  }

  /**
   * Adopt the door's own answer for where this body is.
   *
   * The door builds a fresh attachment from the join credential's world claim,
   * so every reconnect reseats the avatar in the deployment's home world
   * whatever it had travelled to. Left unresynced, `travelTo` would
   * short-circuit on a destination the body is no longer in and report a move
   * that never happened. The door is authoritative here; a name outside the
   * door's own grammar is refused rather than adopted, and the place map is
   * re-resolved from the new world on the next turn.
   */
  resyncWorld(world: string): void {
    const authoritative = world.trim();
    if (!EIDOVERSE_WORLD_NAME_PATTERN.test(authoritative)) {
      (this.deps.logger ?? console).warn("Eidoverse world resync refused: invalid world name");
      return;
    }
    if (authoritative === this.currentWorldName) return;
    this.currentWorldName = authoritative;
    this.currentRegion = undefined;
    // An arrival note for a world the body is no longer in is worse than no
    // note: it would narrate a move the reconnect has already undone.
    this.arrivalNote = null;
    (this.deps.logger ?? console).warn("Eidoverse world belief resynced from the door");
  }

  private refuseTravel(reason: EidoverseTravelRefusal): EidoverseTravelOutcome {
    (this.deps.logger ?? console).warn(`Eidoverse travel refused: ${reason}`);
    return { accepted: false, world: this.currentWorldName, reason };
  }

  private placeIdFor(world: string, region?: string): { placeId?: string } {
    if (!this.config.placeMap) return {};
    const placeId = resolveEidoversePlace(this.config.placeMap, world, region).placeId;
    return placeId ? { placeId } : {};
  }

  /**
   * The one line that tells the model it has a body here and how to use it.
   * Injected every turn (the arrival note is one-shot by design; this is not
   * an event but a standing fact), naming only the verbs this Hub actually
   * wires so the model never reaches for a surface that is not there.
   */
  private affordanceNote(placeId: string | undefined): { key: string; text: string } {
    const canWalk = Boolean(this.deps.body);
    const canTravel = Boolean(this.deps.travel);
    const here = placeId ? ` (placeId ${JSON.stringify(placeId)})` : "";
    const verbs: string[] = [
      `action=perceive${placeId ? ` with placeId ${JSON.stringify(placeId)}` : ""} to look around: your own position, everyone here with their id and (x, z), and the things placed nearby`,
    ];
    if (canWalk) {
      verbs.push(
        'action=move with participant:"<id>" to walk over to someone, position:{x,z} to walk to a spot, or placeId to go to a mapped place',
        "action=act with verb face|stop|emote|posture (and spawn|remove|set_avatar when your tier allows) for body verbs",
      );
    }
    if (canTravel) verbs.push("action=move with the placeId of a place in another world to travel there");
    const body = canWalk
      ? "You have a body in this 3D world and can explore it: walk to people and places, look around, and act."
      : "You have a presence in this 3D world and can look around.";
    const ais = [...this.participantKinds.entries()].filter(([, kind]) => kind === "ai").map(([id]) => JSON.stringify(id));
    const humans = [...this.participantKinds.entries()].filter(([, kind]) => kind === "human").map(([id]) => JSON.stringify(id));
    const roster = " Everyone here is an AI unless the world marks them human"
      + (humans.length > 0 ? `; humans so far: ${humans.join(", ")}` : "")
      + (ais.length > 0 ? `; other AI companions: ${ais.join(", ")}` : "")
      + ". Answer AIs briefly and do not keep a conversation going with them on your own.";
    return {
      key: "eidoverse.affordances",
      text: `${body} You are in the Eidoverse world ${JSON.stringify(this.currentWorldName)}${here}. `
        + "In-world messages are prefixed by the speaker's id."
        + roster
        + " Use the world tool: "
        + `${verbs.join("; ")}. A move answers whether you arrived; a longer walk reports on a later turn. Use these on your own initiative, not only when asked.`,
    };
  }

  /**
   * Publishes only the completed companion reply. The durable session retains
   * the full reply; the world-bound copy is deterministically limited to the
   * MCP `say` protocol maximum. Publication is best-effort and never retries.
   */
  private async publishReply(responseText: string): Promise<void> {
    const sayText = responseText.trim().slice(0, EIDOVERSE_SAY_MAX_TEXT_LENGTH);
    if (!sayText) return;
    try {
      await this.deps.say.say(sayText);
    } catch {
      (this.deps.logger ?? console).warn("Eidoverse in-world say failed");
    }
  }

  private channelContext(
    region: string | undefined,
    ownership: SatelliteAttachmentOwnership,
    lookNotes: NonNullable<PsfnChannelContext["contextNotes"]>,
    capture: VisionCaptureImage | null,
    speaker?: EidoverseSpeaker,
  ): PsfnChannelContext {
    const normalizedRegion = normalizeOptional(region) ?? this.currentRegion;
    const place = this.resolvePlace(normalizedRegion);
    const base = this.deps.embodiedSessions.getContext(
      this.conversationId,
      this.config.satelliteClaim.satelliteId,
      ownership,
    );
    const contextNotes = [...(this.deps.body?.drainNotes() ?? []), ...lookNotes];
    // Drained, not read: arrival is an event, and a note that re-injected
    // itself every turn would keep telling the companion it had just arrived
    // somewhere it has been sitting in for an hour.
    const arrivalNote = this.arrivalNote;
    this.arrivalNote = null;
    if (arrivalNote) contextNotes.push(arrivalNote);
    if (place.contextNote) {
      contextNotes.push({ key: "eidoverse.place", text: place.contextNote });
    }
    // Appended after the bound: the look budget stays twelve lines and the
    // standing "you have a body here" note is never the one dropped.
    const boundedContextNotes = [
      ...contextNotes.slice(-MAX_EIDOVERSE_CONTEXT_NOTES),
      this.affordanceNote(place.placeId),
    ];
    return {
      ...base,
      ...(place.placeId ? { placeId: place.placeId } : {}),
      // The assertion binds the enrollment place, not the region the body
      // stands in: the gateway checks it against the static satellite place.
      ...(base.deviceAuthority ? { assertionPlaceId: base.deviceAuthority.placeId ?? null } : {}),
      ...(speaker ? { speaker } : {}),
      // One first-person frame per turn, carried on the same seam Voxta uses:
      // stripped metadata for the outbound channel record, the image itself
      // only for the model turn.
      ...(capture
        ? {
          visionCaptures: [stripVisionCaptureImageData(capture)],
          visionCaptureImages: [capture],
        }
        : {}),
      ...(boundedContextNotes.length > 0 ? { contextNotes: boundedContextNotes } : {}),
    };
  }

  /**
   * The companion asks for a look through the door's camera. Never throws:
   * an absent renderer, a missing body or a frame that never comes are all
   * `available: false`, exactly like the per-turn vision path degrades.
   */
  async snapshot(view: "first" | "third" | "selfie" = "first"): Promise<EidoverseAvatarSnapshot> {
    this.requireConnection();
    const world = this.currentWorldName;
    const snapshot = this.deps.snapshot;
    if (!snapshot) return { available: false, world, view, reason: "not_configured" };
    try {
      const image = await snapshot.capture(this.conversationId, world, view);
      if (!image) return { available: false, world, view, reason: "unavailable" };
      return {
        available: true,
        world,
        view,
        mimeType: image.mimeType,
        dataBase64: image.dataBase64,
        bytes: image.bytes,
        capturedAt: image.capturedAt,
      };
    } catch {
      (this.deps.logger ?? console).warn("Eidoverse snapshot failed");
      return { available: false, world, view, reason: "unavailable" };
    }
  }

  private async captureSnapshot(): Promise<VisionCaptureImage | null> {
    const snapshot = this.deps.snapshot;
    if (!snapshot) return null;
    try {
      // The world the body is in right now, not the one the session was
      // founded in: travel moves the avatar out of the boot world entirely.
      return await snapshot.capture(this.conversationId, this.currentWorldName);
    } catch {
      // A snapshot never fails a turn; the text look notes remain the tier.
      (this.deps.logger ?? console).warn("Eidoverse snapshot failed");
      return null;
    }
  }

  private async lookContextNotes(): Promise<NonNullable<PsfnChannelContext["contextNotes"]>> {
    let lookText: string;
    try {
      lookText = await this.deps.look.look();
    } catch {
      this.deps.onLookError?.();
      return [];
    }
    return lookText
      .split(/\r?\n/u)
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .map((text) => ({ key: "eidoverse.look", text }))
      .slice(-MAX_EIDOVERSE_CONTEXT_NOTES);
  }

  private resolvePlace(region: string | undefined): EidoversePlaceResolution {
    return this.config.placeMap
      ? resolveEidoversePlace(this.config.placeMap, this.currentWorldName, region)
      : {};
  }

  private requireConnection(): SatelliteAttachmentOwnership {
    if (!this.attachmentOwnership) {
      throw new Error("Eidoverse embodied session is not connected");
    }
    return this.attachmentOwnership;
  }
}

function stableConversationId(worldName: string, satelliteId: string): string {
  const digest = createHash("sha256")
    .update(worldName, "utf8")
    .update("\0")
    .update(satelliteId, "utf8")
    .digest("hex");
  return `eidoverse:${digest}`;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function stripVisionCaptureImageData(
  capture: VisionCaptureImage,
): NonNullable<PsfnChannelContext["visionCaptures"]>[number] {
  const { dataBase64: _dataBase64, ...metadata } = capture;
  return metadata;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

async function withBoundedWait<T>(run: Promise<T>, waitMs: number): Promise<T | "pending"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), Math.max(0, waitMs));
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import { createHash } from "node:crypto";

import type { PsfnSatelliteClaimConfig } from "./satellite-claim.js";
import { defaultCapabilitiesForProfile } from "./satellite-claim.js";
import {
  resolveEidoversePlace,
  type EidoversePlaceMap,
  type EidoversePlaceResolution,
} from "./eidoverse-place-map.js";
import {
  type EmbodiedSessionRegistry,
  type PsfnChannelContext,
  type SatelliteAttachmentOwnership,
  type VisionCaptureImage,
} from "./embodied-session.js";
import {
  parseEidoverseBodyAction,
  type EidoverseBodyRunner,
} from "./eidoverse-body-runner.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { EIDOVERSE_SAY_MAX_TEXT_LENGTH } from "./eidoverse-mcp.js";
import type { SessionStore } from "./session-store.js";

const MAX_EIDOVERSE_CONTEXT_NOTES = 12;

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
}

export interface EidoverseLookSource {
  look(): Promise<string>;
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
  capture(sessionId: string, world: string): Promise<VisionCaptureImage | null>;
}

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
}

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
  private arrivalNote: { key: string; text: string } | null = null;
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
    });
    this.attachmentOwnership = attachment.ownership;
    this.deps.sessions.touch(this.conversationId);
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
    const channel = this.channelContext(input.region, ownership, lookNotes, capture);
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
    // An arrival note for a world the body is no longer in is worse than no
    // note: it would narrate a move the reconnect has already undone.
    this.arrivalNote = null;
    (this.deps.logger ?? console).warn("Eidoverse world belief resynced from the door");
  }

  private refuseTravel(reason: EidoverseTravelRefusal): EidoverseTravelOutcome {
    (this.deps.logger ?? console).warn(`Eidoverse travel refused: ${reason}`);
    return { accepted: false, world: this.currentWorldName, reason };
  }

  private placeIdFor(world: string): { placeId?: string } {
    if (!this.config.placeMap) return {};
    const placeId = resolveEidoversePlace(this.config.placeMap, world).placeId;
    return placeId ? { placeId } : {};
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
  ): PsfnChannelContext {
    const normalizedRegion = normalizeOptional(region);
    const place = this.resolvePlace(normalizedRegion);
    const base = this.deps.embodiedSessions.getContext(
      this.conversationId,
      this.config.satelliteClaim.satelliteId,
      ownership,
    );
    const contextNotes = [...(this.deps.body?.drainNotes() ?? []), ...lookNotes];
    if (this.arrivalNote) contextNotes.push(this.arrivalNote);
    if (place.contextNote) {
      contextNotes.push({ key: "eidoverse.place", text: place.contextNote });
    }
    const boundedContextNotes = contextNotes.slice(-MAX_EIDOVERSE_CONTEXT_NOTES);
    return {
      ...base,
      ...(place.placeId ? { placeId: place.placeId } : {}),
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

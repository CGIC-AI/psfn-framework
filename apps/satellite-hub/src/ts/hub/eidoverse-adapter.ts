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
} from "./embodied-session.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { EIDOVERSE_SAY_MAX_TEXT_LENGTH } from "./eidoverse-mcp.js";
import type { SessionStore } from "./session-store.js";

const MAX_EIDOVERSE_CONTEXT_NOTES = 12;

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
  private readonly consumedUtteranceIds = new Set<string>();
  private readonly activeReplies = new Set<AbortController>();
  private attachmentOwnership: SatelliteAttachmentOwnership | null = null;

  constructor(
    private readonly config: EidoverseEmbodiedSessionConfig,
    private readonly deps: EidoverseEmbodiedSessionDependencies,
  ) {
    this.worldName = requireNonEmpty(config.worldName, "Eidoverse world name");
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

  async handleAddressedUtterance(input: EidoverseAddressedUtterance): Promise<string | null> {
    const ownership = this.requireConnection();
    const utteranceId = requireNonEmpty(input.utteranceId, "Eidoverse utterance ID");
    const userText = requireNonEmpty(input.userText, "Eidoverse addressed utterance text");
    if (this.consumedUtteranceIds.has(utteranceId)) return null;
    this.consumedUtteranceIds.add(utteranceId);

    const lookNotes = await this.lookContextNotes();
    const channel = this.channelContext(input.region, ownership, lookNotes);
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
  ): PsfnChannelContext {
    const normalizedRegion = normalizeOptional(region);
    const place = this.resolvePlace(normalizedRegion);
    const base = this.deps.embodiedSessions.getContext(
      this.conversationId,
      this.config.satelliteClaim.satelliteId,
      ownership,
    );
    const contextNotes = [...lookNotes];
    if (place.contextNote) {
      contextNotes.push({ key: "eidoverse.place", text: place.contextNote });
    }
    const boundedContextNotes = contextNotes.slice(-MAX_EIDOVERSE_CONTEXT_NOTES);
    return {
      ...base,
      ...(place.placeId ? { placeId: place.placeId } : {}),
      ...(boundedContextNotes.length > 0 ? { contextNotes: boundedContextNotes } : {}),
    };
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
      ? resolveEidoversePlace(this.config.placeMap, this.worldName, region)
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

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

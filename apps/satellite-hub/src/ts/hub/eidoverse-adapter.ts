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
import type { SessionStore } from "./session-store.js";

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

export interface EidoverseEmbodiedSessionDependencies {
  embodiedSessions: EmbodiedSessionRegistry;
  sessions: SessionStore;
  agent: FrameworkAgentAdapter;
}

/**
 * Protocol-neutral embodiment seam for an Eidoverse visitor. The wake source
 * supplies addressed utterances; this adapter owns only session continuity,
 * deduplication, and the single FrameworkAgentAdapter call for each utterance.
 */
export class EidoverseEmbodiedSessionAdapter {
  readonly conversationId: string;

  private readonly worldName: string;
  private readonly agentName: string;
  private readonly consumedUtteranceIds = new Set<string>();
  private readonly activeReplies = new Set<AbortController>();
  private attachmentOwnership: SatelliteAttachmentOwnership | null = null;

  constructor(
    private readonly config: EidoverseEmbodiedSessionConfig,
    private readonly deps: EidoverseEmbodiedSessionDependencies,
  ) {
    this.worldName = requireNonEmpty(config.worldName, "Eidoverse world name");
    this.agentName = requireNonEmpty(config.agentName, "Eidoverse agent name");
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

    const channel = this.channelContext(input.region, ownership);
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
      }
      return responseText;
    } finally {
      this.activeReplies.delete(controller);
    }
  }

  private channelContext(
    region: string | undefined,
    ownership: SatelliteAttachmentOwnership,
  ): PsfnChannelContext {
    const normalizedRegion = normalizeOptional(region);
    const place = this.resolvePlace(normalizedRegion);
    const base = this.deps.embodiedSessions.getContext(
      this.conversationId,
      this.config.satelliteClaim.satelliteId,
      ownership,
    );
    const location = normalizedRegion
      ? `, region ${JSON.stringify(normalizedRegion)}`
      : "";
    const contextNotes: NonNullable<PsfnChannelContext["contextNotes"]> = [{
      key: "eidoverse.world",
      text: `Avatar ${JSON.stringify(this.agentName)} is in Eidoverse world ${JSON.stringify(this.worldName)}${location}.`,
    }];
    if (place.contextNote) {
      contextNotes.push({ key: "eidoverse.place", text: place.contextNote });
    }
    return {
      ...base,
      ...(place.placeId ? { placeId: place.placeId } : {}),
      contextNotes,
    };
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

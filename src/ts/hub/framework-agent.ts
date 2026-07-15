import type { PsfnChannelContext } from "./embodied-session.js";
import type { ConversationMessage } from "./session-store.js";
import type { RuntimeIdentity } from "../shared/protocol.js";

export type FrameworkReplyInputMode = "text" | "voice";

export interface FrameworkAgentAdapter {
  streamReply(input: {
    /**
     * Protocol-owned origin of this turn. Callers must pass it explicitly;
     * adapters must not guess latency policy from text or capabilities.
     */
    inputMode: FrameworkReplyInputMode;
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
    channel?: PsfnChannelContext;
    /**
     * Cancels the in-flight request (and any bounded fallback attempt) when the
     * caller disconnects or interrupts. Abort is propagated to the
     * underlying HTTP request, not merely observed between deltas.
     */
    signal?: AbortSignal;
  }): AsyncGenerator<string, string, void>;

  getIdentity?(): Promise<RuntimeIdentity | null>;

  close(): Promise<void>;
}

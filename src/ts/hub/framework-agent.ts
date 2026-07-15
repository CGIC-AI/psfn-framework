import type { PsfnChannelContext } from "./embodied-session.js";
import type { ConversationMessage } from "./session-store.js";
import type { RuntimeIdentity } from "../shared/protocol.js";

export interface FrameworkAgentAdapter {
  streamReply(input: {
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
    channel?: PsfnChannelContext;
    /**
     * Cancels the in-flight request (and any bounded fallback attempt) when the
     * voice client disconnects or interrupts. Abort is propagated to the
     * underlying HTTP request, not merely observed between deltas.
     */
    signal?: AbortSignal;
  }): AsyncGenerator<string, string, void>;

  getIdentity?(): Promise<RuntimeIdentity | null>;

  close(): Promise<void>;
}

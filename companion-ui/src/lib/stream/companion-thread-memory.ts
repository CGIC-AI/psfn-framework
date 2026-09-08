import {
  createInitialHubStreamState,
  type HubStreamMessage,
  type HubStreamState,
} from './hub-stream.js';

type RememberedMessage = Pick<HubStreamMessage, 'role' | 'content' | 'receivedAt'>;

/**
 * Finalized main-thread text for companion switching during one account session.
 * The owner must clear on account/connection authority loss and retain only the
 * current authorized roster. Each save replaces that companion's transcript;
 * this adds no history beyond the messages already held by the stream store.
 */
export class CompanionThreadMemory {
  private readonly threads = new Map<string, RememberedMessage[]>();

  save(companionId: string, state: HubStreamState): void {
    // A selected shard's transcript belongs to its server-provided history.
    if (state.session?.activeShardId !== undefined) return;

    const messages = state.messages
      .filter((message) => message.final && !message.live)
      .map(({ role, content, receivedAt }) => ({ role, content, receivedAt }));
    if (messages.length === 0) {
      this.threads.delete(companionId);
    } else {
      this.threads.set(companionId, messages);
    }
  }

  /** Use only as a new HubStreamStore's initialState, never over a live store. */
  restore(companionId: string, at?: string): HubStreamState {
    const messages = (this.threads.get(companionId) ?? []).map((message, index) => ({
      ...message,
      // Original IDs embed session authority. Start fresh local correlation
      // from the array order rather than retaining transport event sequences.
      id: `remembered:${index + 1}:${message.role}`,
      sequence: index + 1,
      live: false,
      final: true,
    }));
    return {
      ...createInitialHubStreamState(at),
      messages,
      sequence: messages.length,
    };
  }

  retain(companionIds: Iterable<string>): void {
    const authorizedIds = new Set(companionIds);
    for (const companionId of this.threads.keys()) {
      if (!authorizedIds.has(companionId)) this.threads.delete(companionId);
    }
  }

  clear(): void {
    this.threads.clear();
  }
}

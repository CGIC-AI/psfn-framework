export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface SessionState {
  updatedAt: number;
  messages: ConversationMessage[];
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly ttlSeconds: number) {}

  getHistory(sessionId: string): ConversationMessage[] {
    this.cleanup();
    return [...(this.sessions.get(sessionId)?.messages ?? [])];
  }

  append(sessionId: string, message: ConversationMessage): void {
    const current = this.sessions.get(sessionId) ?? { updatedAt: Date.now(), messages: [] };
    current.updatedAt = Date.now();
    current.messages.push(message);
    if (current.messages.length > 12) {
      current.messages = current.messages.slice(-12);
    }
    this.sessions.set(sessionId, current);
  }

  touch(sessionId: string): void {
    const current = this.sessions.get(sessionId) ?? { updatedAt: Date.now(), messages: [] };
    current.updatedAt = Date.now();
    this.sessions.set(sessionId, current);
  }

  cleanup(): void {
    const cutoff = Date.now() - this.ttlSeconds * 1000;
    for (const [sessionId, state] of this.sessions.entries()) {
      if (state.updatedAt < cutoff) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

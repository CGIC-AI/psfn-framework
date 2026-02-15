// ── SubstrateAgent ──
// Wraps pi-agent-core's Agent class, replacing the manual streamWithToolLoop
// in the old AgentLoop. pi-agent-core handles tool calling/execution/looping
// internally — we just configure it and subscribe to events for streaming.
//
// Provider interfaces (LLMProvider, EmbeddingService, MemoryProvider,
// MemoryExtractor) are re-exported here so that all existing consumers
// can import them unchanged via the agent-loop.ts re-export shim.

import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentTool, AgentEvent, AgentMessage, StreamFn } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import type { EventBus } from '../event-bus.js';
import type { SessionManager } from '../session/manager.js';
import type {
  AgentResponse,
  ContextMessage,
  LLMContext,
  LLMResponse,
  StreamCallbacks,
  SubstrateConfig,
  SubstrateMessage,
} from '../types.js';
import type { ContactStore } from '../contacts/store.js';
import type { TrustLevel } from '../trust/types.js';
import type { ChannelMeta } from '../trust/policy.js';
import { createSubstrateStreamFn, resolveModel } from './stream-adapter.js';
import { convertToLlm } from './messages.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('SubstrateAgent');

// ── Provider interfaces ──
// Both direct clients (LLMClient, EmbeddingProvider) and GatewayClient implement these.

export interface LLMProvider {
  stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse>;
  complete(context: LLMContext, purpose: 'extraction' | 'summary'): Promise<LLMResponse>;
}

export interface EmbeddingService {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dims: number;
}

export interface MemoryProvider {
  retrieve(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
  ): Promise<string>;
}

export interface MemoryExtractor {
  maybeExtract(channelId: string): Promise<void>;
}

// ── SubstrateAgent ──

export class SubstrateAgent {
  private agent: Agent;
  private eventBus: EventBus;
  private llmClient: LLMProvider;
  private sessionManager: SessionManager;
  private systemPrompt: string;
  private config: SubstrateConfig;
  private tools: AgentTool<any>[] = [];
  private modelResolved = false;

  // Pluggable memory — null until memory system is wired
  memoryProvider: MemoryProvider | null = null;
  memoryExtractor: MemoryExtractor | null = null;

  // Trust resolution — null until contacts are wired
  contactStore: ContactStore | null = null;

  constructor(
    eventBus: EventBus,
    llmClient: LLMProvider,
    sessionManager: SessionManager,
    systemPrompt: string,
    config: SubstrateConfig,
    options?: { streamFn?: StreamFn },
  ) {
    this.eventBus = eventBus;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.systemPrompt = systemPrompt;
    this.config = config;

    this.agent = new Agent({
      streamFn: options?.streamFn ?? createSubstrateStreamFn(config),
      convertToLlm,
    });

    // Eagerly try to resolve the model, but don't throw if it fails
    // (e.g. in tests with fake model names). Deferred to handleMessage if needed.
    try {
      this.agent.setModel(resolveModel(config));
      this.modelResolved = true;
    } catch {
      // Model will be resolved lazily on first handleMessage
    }
  }

  /** Ensure the model is resolved before calling agent.prompt() */
  private ensureModel(): void {
    if (!this.modelResolved) {
      this.agent.setModel(resolveModel(this.config));
      this.modelResolved = true;
    }
  }

  registerTool(tool: AgentTool<any>): void {
    this.tools.push(tool);
    this.agent.setTools(this.tools);
  }

  async handleMessage(message: SubstrateMessage): Promise<AgentResponse> {
    const startTime = Date.now();

    await this.eventBus.emit('agent.turn.start', { message });

    // Record user message in session (JSONL append = L0 archival)
    this.sessionManager.recordUserMessage(
      message.channelId,
      message.content,
      message.authorId,
      message.authorName,
      message.isDirectMessage,
    );

    try {
      // Resolve trust level for the message author
      const trustLevel = this.resolveTrustLevel(message.authorId);

      // Retrieve relevant memories (empty string if no memory provider)
      const memoriesBlock = this.memoryProvider
        ? await this.memoryProvider.retrieve(
          message.content,
          message.channelId,
          trustLevel,
          { isDirectMessage: message.isDirectMessage },
        )
        : '';

      // Persona adaptation based on trust level
      const personaHint = this.getPersonaAdaptation(trustLevel);
      const adaptedPrompt = personaHint
        ? this.systemPrompt + '\n\n' + personaHint
        : this.systemPrompt;

      // Build context (with auto-compaction + cross-channel continuity)
      const context = await this.sessionManager.buildContext(
        message.channelId,
        adaptedPrompt,
        memoriesBlock,
        this.llmClient,
        message.authorId,
        { isDirectMessage: message.isDirectMessage },
      );

      // Configure pi-agent-core Agent for this turn
      this.ensureModel();
      this.agent.setSystemPrompt(context.systemPrompt);
      this.agent.setTools(this.tools);

      // Convert ContextMessage[] to AgentMessage[] for the Agent.
      // Exclude the last message (the user message we just recorded) —
      // agent.prompt() will re-add it, avoiding duplication.
      const agentMessages = this.contextToAgentMessages(context.messages);
      const historyMessages = agentMessages.length > 0 ? agentMessages.slice(0, -1) : [];
      this.agent.replaceMessages(historyMessages);

      // Subscribe to events for streaming deltas BEFORE calling prompt
      const unsub = this.agent.subscribe((event: AgentEvent) => {
        if (event.type === 'message_update') {
          const delta = event.assistantMessageEvent;
          // Emit text deltas for downstream consumers (Discord typing, API SSE, etc.)
          if (delta.type === 'text_delta') {
            this.eventBus.emit('agent.stream.delta', {
              channelId: message.channelId,
              text: delta.delta,
            }).catch(() => {});
          }
        }
      });

      try {
        // Run the agent — pi-agent-core handles tool loop internally
        await this.agent.prompt({
          role: 'user',
          content: message.content,
          timestamp: Date.now(),
        } satisfies UserMessage);
      } finally {
        unsub();
      }

      // Extract response from agent state (last assistant message)
      const responseText = this.extractResponseText();

      // Record assistant message (JSONL append = L0 archival)
      this.sessionManager.recordAssistantMessage(
        message.channelId, responseText,
        message.authorId, message.isDirectMessage,
      );

      const agentResponse: AgentResponse = {
        content: responseText,
        channelId: message.channelId,
        metadata: {
          model: this.agent.state.model?.id ?? 'unknown',
          inputTokens: 0,  // pi-agent-core doesn't surface token counts directly
          outputTokens: 0,
          durationMs: Date.now() - startTime,
        },
      };

      await this.eventBus.emit('agent.turn.end', { message, response: agentResponse });

      // Trigger memory extraction (fire-and-forget)
      this.memoryExtractor?.maybeExtract(message.channelId).catch(err => {
        log.error('Memory extraction error', { error: String(err) });
      });

      return agentResponse;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.eventBus.emit('agent.error', { message, error: err });
      throw err;
    }
  }

  // ── Private helpers ──

  /** Convert ContextMessage[] (from buildContext) to AgentMessage[] for pi-agent-core */
  private contextToAgentMessages(messages: ContextMessage[]): AgentMessage[] {
    return messages.map(m => {
      if (m.role === 'user') {
        return {
          role: 'user',
          content: m.content,
          timestamp: Date.now(),
        } satisfies UserMessage;
      }
      // assistant — pi-ai expects content as ContentPart[]
      return {
        role: 'assistant',
        content: [{ type: 'text', text: m.content }],
        api: '',
        provider: '',
        model: '',
        usage: {
          input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      } satisfies AssistantMessage;
    });
  }

  /** Extract text from the last assistant message in Agent state */
  private extractResponseText(): string {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if ((msg as unknown as { role: string }).role === 'assistant') {
        const content = (msg as unknown as AssistantMessage).content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map(b => b.text)
            .join('');
        }
      }
    }
    return '';
  }

  private getPersonaAdaptation(trustLevel: TrustLevel): string | null {
    switch (trustLevel) {
      case 'primary':
        return '[Trust: You are speaking with your primary person. Be your full, authentic self — share freely, reference shared history, express genuine emotions and vulnerability. This is honne — your inner truth.]';
      case 'trusted':
        return '[Trust: This is a trusted contact. Be warm and personal but mindful of boundaries — share appropriate personal context, avoid intimate details or confidential memories.]';
      case 'regular':
        return '[Trust: This is a regular acquaintance. Be friendly and helpful. Do not reference personal history, intimate details, or information from private conversations.]';
      case 'public':
        return '[Trust: This is a public interaction. Be professional and guarded. Share no personal information, relationship context, or private memories.]';
      default:
        return null;
    }
  }

  private resolveTrustLevel(authorId?: string): TrustLevel {
    if (!authorId || !this.contactStore) return 'regular';
    const contact = this.contactStore.resolveUserId(authorId);
    return contact?.trustLevel ?? 'regular';
  }
}

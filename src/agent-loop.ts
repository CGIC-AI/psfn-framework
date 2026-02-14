import type {
  AgentResponse,
  LLMContext,
  LLMResponse,
  StreamCallbacks,
  SubstrateConfig,
  SubstrateMessage,
  SubstrateTool,
  ToolCall,
} from './types.js';
import type { EventBus } from './event-bus.js';
import type { SessionManager } from './session/manager.js';
import type { TrustLevel } from './trust/types.js';
import type { ContactStore } from './contacts/store.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('AgentLoop');

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
  retrieve(contextText: string, channelId: string, trustLevel?: TrustLevel): Promise<string>;
}

export interface MemoryExtractor {
  maybeExtract(channelId: string): Promise<void>;
}

const MAX_TOOL_LOOPS = 5;

export class AgentLoop {
  private eventBus: EventBus;
  private llmClient: LLMProvider;
  private sessionManager: SessionManager;
  private systemPrompt: string;
  private config: SubstrateConfig;
  private tools: Map<string, SubstrateTool> = new Map();

  // Pluggable memory — null until Sprint 2 wires it
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
  ) {
    this.eventBus = eventBus;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.systemPrompt = systemPrompt;
    this.config = config;
  }

  registerTool(tool: SubstrateTool): void {
    this.tools.set(tool.name, tool);
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
    );

    try {
      // Resolve trust level for the message author
      const trustLevel = this.resolveTrustLevel(message.authorId);

      // Retrieve relevant memories (empty string if no memory provider)
      const memoriesBlock = this.memoryProvider
        ? await this.memoryProvider.retrieve(message.content, message.channelId, trustLevel)
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
      );

      // Stream LLM response with tool loop
      let response = await this.streamWithToolLoop(context, message.channelId);

      // Record assistant message (JSONL append = L0 archival)
      this.sessionManager.recordAssistantMessage(message.channelId, response.content, message.authorId);

      const agentResponse: AgentResponse = {
        content: response.content,
        channelId: message.channelId,
        metadata: {
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
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

  /** Get tool schemas for sending to LLM (no execute functions, wire-safe). */
  private getToolSchemas(): import('./types.js').ToolSchema[] {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  private async streamWithToolLoop(
    context: LLMContext,
    channelId: string,
  ): Promise<LLMResponse> {
    // Include tool schemas so the LLM knows what tools are available
    const toolSchemas = this.getToolSchemas();
    let currentContext: LLMContext = {
      ...context,
      ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
    };
    let loops = 0;

    while (loops < MAX_TOOL_LOOPS) {
      const response = await this.llmClient.stream(currentContext, {
        onText: (text) => {
          this.eventBus.emit('agent.stream.delta', { channelId, text }).catch(() => {});
        },
      });

      // No tool calls — we're done
      if (response.toolCalls.length === 0) {
        return response;
      }

      // Execute tool calls
      const toolResults = await this.executeToolCalls(response.toolCalls);

      // Append assistant message + tool results to context for next loop
      currentContext = {
        ...currentContext,
        messages: [
          ...currentContext.messages,
          { role: 'assistant' as const, content: response.content },
          { role: 'user' as const, content: toolResults },
        ],
      };

      loops++;
    }

    // Exceeded tool loop limit — return last response
    return this.llmClient.stream(currentContext);
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

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<string> {
    const results: string[] = [];

    for (const call of toolCalls) {
      const tool = this.tools.get(call.name);
      if (!tool) {
        results.push(`Tool "${call.name}" not found.`);
        continue;
      }

      try {
        const result = await tool.execute(call.input);
        results.push(`[${call.name}]: ${result.content}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push(`[${call.name}] Error: ${msg}`);
      }
    }

    return results.join('\n\n');
  }
}

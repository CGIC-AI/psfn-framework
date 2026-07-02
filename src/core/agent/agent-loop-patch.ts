import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { LLMSystemPromptCacheBoundaries } from '../../shared/contracts/runtime.js';
import { agentLoopContinueWithScheduler, agentLoopWithScheduler } from './scheduled-agent-loop.js';
import type { ToolCallSchedulerOptions } from './tool-call-scheduler.js';

export interface AgentLoopPromptCacheHooks {
  /**
   * Resolve the PromptPlan cachePlan boundaries for the EXACT system prompt
   * the loop is about to ship (E2.4). Implementations must return undefined
   * unless the given system prompt byte-matches the prompt the boundaries
   * were computed for — stale boundaries are worse than none.
   */
  resolvePromptCacheBoundaries?: (systemPrompt: string) => LLMSystemPromptCacheBoundaries | undefined;
}

type PatchedAgent = {
  __psfnToolSchedulerPatched?: boolean;
  _runLoop: (messages?: AgentMessage[], options?: { skipInitialSteeringPoll?: boolean }) => Promise<void>;
  emit: (event: unknown) => void;
  appendMessage: (message: AgentMessage) => void;
  dequeueSteeringMessages: () => AgentMessage[];
  dequeueFollowUpMessages: () => AgentMessage[];
  abortController?: AbortController;
  runningPrompt?: Promise<void>;
  resolveRunningPrompt?: () => void;
  _state: any;
  _sessionId?: string;
  _thinkingBudgets?: any;
  _transport?: any;
  _maxRetryDelayMs?: number;
  convertToLlm: any;
  transformContext?: any;
  getApiKey?: any;
  streamFn?: any;
};

export function installAgentToolSchedulerPatch(
  agent: Agent,
  schedulerOptions: ToolCallSchedulerOptions,
  promptCacheHooks?: AgentLoopPromptCacheHooks,
): void {
  const target = agent as unknown as PatchedAgent;
  if (target.__psfnToolSchedulerPatched) {
    return;
  }

  target._runLoop = async function patchedRunLoop(
    this: PatchedAgent,
    messages?: AgentMessage[],
    options?: { skipInitialSteeringPoll?: boolean },
  ): Promise<void> {
    const model = this._state.model;
    if (!model) throw new Error('No model configured');

    this.runningPrompt = new Promise<void>((resolve) => {
      this.resolveRunningPrompt = resolve;
    });
    this.abortController = new AbortController();
    this._state.isStreaming = true;
    this._state.streamMessage = null;
    this._state.error = undefined;

    const reasoning = this._state.thinkingLevel === 'off' ? undefined : this._state.thinkingLevel;
    const promptCacheBoundaries = promptCacheHooks?.resolvePromptCacheBoundaries?.(
      typeof this._state.systemPrompt === 'string' ? this._state.systemPrompt : '',
    );
    const context = {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools,
      getTools: () => this._state.tools,
      ...(promptCacheBoundaries ? { promptCacheBoundaries } : {}),
    };
    let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;

    const config = {
      model,
      reasoning,
      sessionId: this._sessionId,
      transport: this._transport,
      thinkingBudgets: this._thinkingBudgets,
      maxRetryDelayMs: this._maxRetryDelayMs,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: this.getApiKey,
      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.dequeueSteeringMessages();
      },
      getFollowUpMessages: async () => this.dequeueFollowUpMessages(),
    };

    let partial: any = null;
    let terminalStreamError: Error | null = null;
    let sawTerminalStreamError = false;
    try {
      const stream = messages
        ? agentLoopWithScheduler(messages, context, config, this.abortController.signal, this.streamFn, schedulerOptions)
        : agentLoopContinueWithScheduler(context, config, this.abortController.signal, this.streamFn, schedulerOptions);

      for await (const rawEvent of stream) {
        const event = rawEvent as any;
        switch (event.type) {
          case 'message_start':
            partial = event.message;
            this._state.streamMessage = event.message;
            break;
          case 'message_update':
            partial = event.message;
            this._state.streamMessage = event.message;
            break;
          case 'message_end':
            partial = null;
            this._state.streamMessage = null;
            this.appendMessage(event.message);
            break;
          case 'tool_execution_start': {
            const pending = new Set(this._state.pendingToolCalls);
            pending.add(event.toolCallId);
            this._state.pendingToolCalls = pending;
            break;
          }
          case 'tool_execution_end': {
            const pending = new Set(this._state.pendingToolCalls);
            pending.delete(event.toolCallId);
            this._state.pendingToolCalls = pending;
            break;
          }
          case 'turn_end':
            if (event.message.role === 'assistant' && event.message.errorMessage) {
              this._state.error = event.message.errorMessage;
            }
            break;
          case 'agent_error':
            const normalizedError = event.error instanceof Error
              ? event.error
              : new Error(String(event.error));
            terminalStreamError = normalizedError;
            sawTerminalStreamError = true;
            partial = null;
            this._state.error = normalizedError.message;
            this._state.streamMessage = null;
            break;
          case 'agent_end':
            this._state.isStreaming = false;
            this._state.streamMessage = null;
            break;
          default:
            break;
        }
        this.emit(event);
      }

      if (terminalStreamError) {
        throw terminalStreamError;
      }

      if (partial && partial.role === 'assistant' && partial.content.length > 0) {
        const onlyEmpty = !partial.content.some((entry: any) => (
          (entry.type === 'thinking' && entry.thinking.trim().length > 0)
          || (entry.type === 'text' && entry.text.trim().length > 0)
          || (entry.type === 'toolCall' && entry.name.trim().length > 0)
        ));
        if (!onlyEmpty) {
          this.appendMessage(partial);
        } else if (this.abortController.signal.aborted) {
          throw new Error('Request was aborted');
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._state.error = errorMessage;
      partial = null;
      if (!sawTerminalStreamError) {
        this.emit({ type: 'agent_error', error: error instanceof Error ? error : new Error(errorMessage), messages: [] } as any);
        this.emit({ type: 'agent_end', messages: [] } as any);
      }
      throw error;
    } finally {
      this._state.isStreaming = false;
      this._state.streamMessage = null;
      this._state.pendingToolCalls = new Set();
      this.resolveRunningPrompt?.();
      this.runningPrompt = undefined;
      this.resolveRunningPrompt = undefined;
      this.abortController = undefined;
    }
  };

  target.__psfnToolSchedulerPatched = true;
}

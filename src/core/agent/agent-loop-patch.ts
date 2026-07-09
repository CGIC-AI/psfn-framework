import type { Agent, AgentLoopConfig, AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
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

type PatchedRunOptions = { skipInitialSteeringPoll?: boolean };

/**
 * Private pi-agent-core Agent internals (0.73.x) the scheduler graft relies on.
 *
 * `prompt()` and `continue()` both funnel into `runPromptMessages` /
 * `runContinuation`; overriding those two methods swaps the stock agent loop
 * for PSFN's scheduled loop while keeping the public Agent surface
 * (steer/followUp queues, abort, waitForIdle, subscribe) intact.
 */
type PatchedAgent = {
  __psfnToolSchedulerPatched?: boolean;
  runPromptMessages: (messages: AgentMessage[], options?: PatchedRunOptions) => Promise<void>;
  runContinuation: () => Promise<void>;
  createLoopConfig: (options?: PatchedRunOptions) => AgentLoopConfig;
  processEvents: (event: unknown) => Promise<void>;
  activeRun?: {
    promise: Promise<void>;
    resolve: () => void;
    abortController: AbortController;
  };
  _state: {
    model: unknown;
    systemPrompt: string;
    messages: AgentMessage[];
    tools: AgentTool<any>[];
    isStreaming: boolean;
    streamingMessage?: AgentMessage;
    pendingToolCalls: ReadonlySet<string>;
    errorMessage?: string;
    /**
     * PSFN extension: index into messages where internal follow-up
     * continuation begins for this run (null = no internal continuation).
     */
    userFacingBoundaryIndex?: number | null;
  };
  streamFn: Parameters<typeof agentLoopWithScheduler>[4];
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

  async function runScheduledLoop(
    this: PatchedAgent,
    messages: AgentMessage[] | undefined,
    options?: PatchedRunOptions,
  ): Promise<void> {
    const model = this._state.model;
    if (!model) throw new Error('No model configured');
    if (this.activeRun) {
      throw new Error('Agent is already processing.');
    }

    const abortController = new AbortController();
    let resolveRun: () => void = () => {};
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    this.activeRun = { promise: runPromise, resolve: resolveRun, abortController };
    this._state.isStreaming = true;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;
    // User-facing boundary: index into _state.messages where internal
    // follow-up continuation begins for this run (null = no internal
    // continuation). Reset per run; set once when the loop drains queued
    // internal follow-ups (psfn-framework-ay73).
    this._state.userFacingBoundaryIndex = null;

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
    const config = this.createLoopConfig(options);

    let partial: any = null;
    let terminalStreamError: Error | null = null;
    let sawTerminalStreamError = false;
    try {
      const stream = messages
        ? agentLoopWithScheduler(messages, context, config, abortController.signal, this.streamFn, schedulerOptions)
        : agentLoopContinueWithScheduler(context, config, abortController.signal, this.streamFn, schedulerOptions);

      for await (const rawEvent of stream) {
        const event = rawEvent as any;
        switch (event.type) {
          case 'message_start':
          case 'message_update':
            partial = event.message;
            break;
          case 'message_end':
            partial = null;
            break;
          case 'agent_error': {
            const normalizedError = event.error instanceof Error
              ? event.error
              : new Error(String(event.error));
            terminalStreamError = normalizedError;
            sawTerminalStreamError = true;
            partial = null;
            this._state.errorMessage = normalizedError.message;
            break;
          }
          case 'agent_end':
            this._state.isStreaming = false;
            break;
          case 'user_facing_boundary':
            if (this._state.userFacingBoundaryIndex == null) {
              this._state.userFacingBoundaryIndex = this._state.messages.length;
            }
            // Internal marker for response extraction; not an agent event
            // external subscribers know about.
            continue;
          default:
            break;
        }
        // processEvents applies the stock state reduction (streamingMessage,
        // transcript append on message_end, pendingToolCalls, errorMessage on
        // turn_end) and awaits subscribed listeners. Custom events without a
        // stock case (e.g. agent_error) still reach listeners.
        await this.processEvents(event);
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
          this._state.messages = [...this._state.messages, partial];
        } else if (abortController.signal.aborted) {
          throw new Error('Request was aborted');
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._state.errorMessage = errorMessage;
      partial = null;
      if (!sawTerminalStreamError) {
        await this.processEvents({
          type: 'agent_error',
          error: error instanceof Error ? error : new Error(errorMessage),
          messages: [],
        });
        await this.processEvents({ type: 'agent_end', messages: [] });
      }
      throw error;
    } finally {
      this._state.isStreaming = false;
      this._state.streamingMessage = undefined;
      this._state.pendingToolCalls = new Set();
      const run = this.activeRun;
      this.activeRun = undefined;
      run.resolve();
    }
  }

  target.runPromptMessages = async function patchedRunPromptMessages(
    this: PatchedAgent,
    messages: AgentMessage[],
    options?: PatchedRunOptions,
  ): Promise<void> {
    await runScheduledLoop.call(this, messages, options);
  };

  target.runContinuation = async function patchedRunContinuation(
    this: PatchedAgent,
  ): Promise<void> {
    await runScheduledLoop.call(this, undefined, undefined);
  };

  target.__psfnToolSchedulerPatched = true;
}

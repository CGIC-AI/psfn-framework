import { EventStream, type AssistantMessage } from '@mariozechner/pi-ai';
import type { AgentContext, AgentLoopConfig, AgentMessage, StreamFn } from '@mariozechner/pi-agent-core';
import { executeToolCallsWithScheduler, type ToolCallSchedulerOptions } from './tool-call-scheduler.js';

type AgentLoopErrorEvent = {
  type: 'agent_error';
  error: Error;
  messages: AgentMessage[];
};

const DEFAULT_MAX_ASSISTANT_STEPS_PER_RUN = 12;

export function agentLoopWithScheduler(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
  streamFn: StreamFn | undefined,
  schedulerOptions: ToolCallSchedulerOptions,
) {
  const stream = createAgentStream();
  (async () => {
    const newMessages = [...prompts];
    try {
      const currentContext = {
        ...context,
        messages: [...context.messages, ...prompts],
      };
      stream.push({ type: 'agent_start' });
      stream.push({ type: 'turn_start' });
      for (const prompt of prompts) {
        stream.push({ type: 'message_start', message: prompt });
        stream.push({ type: 'message_end', message: prompt });
      }
      await runLoop(currentContext, newMessages, config, signal, stream, streamFn, schedulerOptions);
    } catch (error) {
      terminateStreamWithError(stream, newMessages, error);
    }
  })();
  return stream;
}

export function agentLoopContinueWithScheduler(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
  streamFn: StreamFn | undefined,
  schedulerOptions: ToolCallSchedulerOptions,
) {
  if (context.messages.length === 0) {
    throw new Error('Cannot continue: no messages in context');
  }
  if (context.messages[context.messages.length - 1]?.role === 'assistant') {
    throw new Error('Cannot continue from message role: assistant');
  }
  const stream = createAgentStream();
  (async () => {
    const newMessages: AgentMessage[] = [];
    try {
      const currentContext = { ...context };
      stream.push({ type: 'agent_start' });
      stream.push({ type: 'turn_start' });
      await runLoop(currentContext, newMessages, config, signal, stream, streamFn, schedulerOptions);
    } catch (error) {
      terminateStreamWithError(stream, newMessages, error);
    }
  })();
  return stream;
}

function createAgentStream() {
  return new EventStream(
    (event: any) => event.type === 'agent_end',
    (event: any) => (event.type === 'agent_end' ? event.messages : []),
  );
}

async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal,
  stream: ReturnType<typeof createAgentStream>,
  streamFn: StreamFn | undefined,
  schedulerOptions: ToolCallSchedulerOptions,
) {
  let firstTurn = true;
  let assistantStepCount = 0;
  let pendingMessages = (await config.getSteeringMessages?.()) || [];

  for (;;) {
    let hasMoreToolCalls = false;
    let steeringAfterTools: AgentMessage[] | null = null;

    do {
      if (!firstTurn) {
        stream.push({ type: 'turn_start' });
      } else {
        firstTurn = false;
      }

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          stream.push({ type: 'message_start', message });
          stream.push({ type: 'message_end', message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      assistantStepCount += 1;
      if (assistantStepCount > DEFAULT_MAX_ASSISTANT_STEPS_PER_RUN) {
        const message = buildLoopLimitMessage(config, assistantStepCount);
        currentContext.messages.push(message);
        newMessages.push(message);
        stream.push({ type: 'message_start', message });
        stream.push({ type: 'message_end', message });
        stream.push({ type: 'turn_end', message, toolResults: [] });
        stream.push({ type: 'agent_end', messages: newMessages });
        stream.end(newMessages);
        return;
      }

      const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
      newMessages.push(message);
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        stream.push({ type: 'turn_end', message, toolResults: [] });
        stream.push({ type: 'agent_end', messages: newMessages });
        stream.end(newMessages);
        return;
      }

      const toolCalls = message.content.filter((content: any) => content.type === 'toolCall');
      hasMoreToolCalls = toolCalls.length > 0;
      const toolResults: any[] = [];
      if (hasMoreToolCalls) {
        const toolExecution = await executeToolCallsWithScheduler(
          currentContext.tools,
          message,
          config.getSteeringMessages,
          { signal, stream },
          schedulerOptions,
        );
        toolResults.push(...toolExecution.toolResults);
        steeringAfterTools = toolExecution.steeringMessages ?? null;
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }
      stream.push({ type: 'turn_end', message, toolResults });

      if (steeringAfterTools && steeringAfterTools.length > 0) {
        pendingMessages = steeringAfterTools;
        steeringAfterTools = null;
      } else {
        pendingMessages = (await config.getSteeringMessages?.()) || [];
      }
    } while (hasMoreToolCalls || pendingMessages.length > 0);

    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }
    break;
  }

  stream.push({ type: 'agent_end', messages: newMessages });
  stream.end(newMessages);
}

function buildLoopLimitMessage(
  config: AgentLoopConfig,
  stepCount: number,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'text',
      text: `Turn stopped after ${stepCount - 1} assistant steps without bounded completion. Retry with a narrower request or fewer dependent tool calls.`,
    }],
    api: config.model.api,
    provider: config.model.provider,
    model: config.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'error',
    errorMessage: 'agent_loop_step_limit_exceeded',
    timestamp: Date.now(),
  } as AssistantMessage;
}

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
  stream: ReturnType<typeof createAgentStream>,
  streamFn: StreamFn | undefined,
): Promise<AssistantMessage> {
  if (!streamFn) {
    throw new Error('Scheduled agent loop requires an explicit streamFn; direct provider fallback is disabled.');
  }
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }
  const llmMessages = await config.convertToLlm(messages);
  const llmContext = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  const response = await streamFn(config.model, llmContext, {
    ...config,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;
  try {
    for await (const event of response) {
      switch (event.type) {
        case 'start':
          partialMessage = event.partial;
          context.messages.push(partialMessage);
          addedPartial = true;
          stream.push({ type: 'message_start', message: { ...partialMessage } });
          break;
        case 'text_start':
        case 'text_delta':
        case 'text_end':
        case 'thinking_start':
        case 'thinking_delta':
        case 'thinking_end':
        case 'toolcall_start':
        case 'toolcall_delta':
        case 'toolcall_end':
          if (partialMessage) {
            partialMessage = event.partial;
            context.messages[context.messages.length - 1] = partialMessage;
            stream.push({
              type: 'message_update',
              assistantMessageEvent: event,
              message: { ...partialMessage },
            });
          }
          break;
        case 'done':
        case 'error': {
          const finalMessage = await resolveStreamResult(response, {
            terminalEvent: event,
            partialMessage,
          });
          if (addedPartial) {
            context.messages[context.messages.length - 1] = finalMessage;
          } else {
            context.messages.push(finalMessage);
          }
          if (!addedPartial) {
            stream.push({ type: 'message_start', message: { ...finalMessage } });
          }
          stream.push({ type: 'message_end', message: finalMessage });
          return finalMessage;
        }
        default:
          break;
      }
    }
  } catch (error) {
    if (addedPartial) {
      context.messages.pop();
    }
    throw error;
  }
  return resolveStreamResult(response, { partialMessage });
}

function terminateStreamWithError(
  stream: ReturnType<typeof createAgentStream>,
  messages: AgentMessage[],
  error: unknown,
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  stream.push({
    type: 'agent_error',
    error: err,
    messages,
  } satisfies AgentLoopErrorEvent);
  stream.push({ type: 'agent_end', messages });
  stream.end(messages);
}

type StreamResolutionContext = {
  terminalEvent?: unknown;
  partialMessage?: AssistantMessage | null;
};

function isAssistantMessage(candidate: unknown): candidate is AssistantMessage {
  return candidate !== null
    && typeof candidate === 'object'
    && (candidate as { role?: unknown }).role === 'assistant'
    && Array.isArray((candidate as { content?: unknown }).content);
}

function resolveEventAssistantMessage(event: unknown): AssistantMessage | undefined {
  if (event === null || typeof event !== 'object') {
    return undefined;
  }
  const terminalEvent = event as { message?: unknown; error?: unknown; partial?: unknown };
  if (isAssistantMessage(terminalEvent.message)) {
    return terminalEvent.message;
  }
  if (isAssistantMessage(terminalEvent.error)) {
    return terminalEvent.error;
  }
  if (isAssistantMessage(terminalEvent.partial)) {
    return terminalEvent.partial;
  }
  return undefined;
}

export async function resolveStreamResult(
  response: { result?: unknown },
  resolutionContext: StreamResolutionContext = {},
): Promise<AssistantMessage> {
  const resultValue = response.result;
  if (typeof resultValue === 'function') {
    const resolved = await resultValue.call(response);
    if (isAssistantMessage(resolved)) {
      return resolved;
    }
  }
  if (resultValue !== undefined) {
    const resolved = await resultValue;
    if (isAssistantMessage(resolved)) {
      return resolved;
    }
  }
  const eventMessage = resolveEventAssistantMessage(resolutionContext.terminalEvent);
  if (eventMessage) {
    return eventMessage;
  }
  if (isAssistantMessage(resolutionContext.partialMessage)) {
    return resolutionContext.partialMessage;
  }
  throw new Error('Stream response missing result payload');
}

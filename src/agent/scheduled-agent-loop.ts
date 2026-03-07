import { EventStream, streamSimple } from '@mariozechner/pi-ai';
import type { AgentContext, AgentLoopConfig, AgentMessage, StreamFn } from '@mariozechner/pi-agent-core';
import { executeToolCallsWithScheduler, type ToolCallSchedulerOptions } from './tool-call-scheduler.js';

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
    const currentContext = { ...context };
    stream.push({ type: 'agent_start' });
    stream.push({ type: 'turn_start' });
    await runLoop(currentContext, newMessages, config, signal, stream, streamFn, schedulerOptions);
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
  let pendingMessages = (await config.getSteeringMessages?.()) || [];

  while (true) {
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

      const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
      newMessages.push(message);
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        stream.push({ type: 'turn_end', message, toolResults: [] });
        stream.push({ type: 'agent_end', messages: newMessages });
        stream.end(newMessages);
        return;
      }

      const toolCalls = message.content.filter((content) => content.type === 'toolCall');
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

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
  stream: ReturnType<typeof createAgentStream>,
  streamFn: StreamFn | undefined,
) {
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

  const resolvedApiKey = (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
  const streamFunction = streamFn || streamSimple;
  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  let partialMessage: any = null;
  let addedPartial = false;
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
        const finalMessage = await response.result();
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
  return response.result();
}

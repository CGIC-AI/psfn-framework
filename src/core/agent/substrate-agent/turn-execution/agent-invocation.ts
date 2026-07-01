import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import { enforceUntrustedCompactionGuard } from '../../../identity/prompt-composer.js';
import {
  formatAttributedSystemContent,
  formatGroupUserMessageContent,
} from '../../../session/entry-attribution.js';
import { runWithVisionToolRequestContext } from '../../../../primitives/images/request-context.js';
import { runWithRequestContext } from '../../../../primitives/llm/request-context.js';
import {
  contextMessagesToPiMessages,
} from '../../../../primitives/llm/message-conversion.js';
import type {
  AgentResponse,
  CorrelationMetadata,
  ObservabilityCallType,
  SubstrateMessage,
  TurnID,
  TurnUsage,
} from '../../../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';
import type { TurnSnapshot, TurnPromptResponseSnapshot } from '../../../turns/snapshot.js';
import { MESSAGE_CLASSES } from '../../message-classes.js';
import type { SystemNoteMessage } from '../../messages.js';
import type { AutoloadTurnOutcome } from '../adaptive-tools-runtime.js';
import { resolveModel } from '../../stream-adapter.js';
import {
  cloneObservedAdaptiveToolSnapshot,
  readActiveTurnToolSchemas,
} from '../turn-tool-context.js';
import {
  buildRuntimeDatetimeAnchorRetryPrompt,
  buildRuntimeDatetimeContradictionRefusal,
  buildRuntimeDatetimeDetectionContext,
  detectRuntimeDatetimeContradiction,
} from '../runtime-datetime-contradiction-guard.js';
import { resolveAppearanceContextFromTemplateVariables } from '../runtime-context.js';
import { sanitizePersistedReasoningText } from '../turn-records.js';
import {
  buildPersistedVisionUnavailableUserContent,
  buildTurnUserContent,
  hasVisionTurnInputs,
} from '../vision-attachments.js';
import {
  resolveMoaSettings,
  runMoaTurn,
} from '../moa-turn.js';
import type { TurnExecutionObservability } from './observability.js';

const log = createComponentLogger('SubstrateAgent');
// Covers attachment fetch (with gateway DNS retries) plus the vision model call;
// 30s proved too tight on slow deployments where the model finished at ~70s.
const VISION_TURN_TIMEOUT_MS = 120_000;
const VISION_RECOVERY_REPLAY_MAX_ATTEMPTS = 3;
const RUNTIME_FALLBACK_MODEL = 'runtime-fallback';
type TurnExecutionRuntime = import('../turn-execution-runtime.js').TurnExecutionRuntime;
type RuntimeContradictionDiagnostic = NonNullable<
NonNullable<AgentResponse['metadata']['diagnostics']>['runtimeContradiction']
>;

export interface AgentInvocationMutableState {
  turnMessages: AgentMessage[];
  turnStartMessageIndex: number | null;
}

export interface AgentInvocationResult {
  firstTokenAt: number;
  turnMessages: AgentMessage[];
  turnUsage: TurnUsage;
  responseModel: string;
  responseText: string;
  fallbackDiagnostics: AgentResponse['metadata']['diagnostics'] | undefined;
  runtimeContradictionDiagnostics: NonNullable<AgentResponse['metadata']['diagnostics']> | undefined;
  turnIntent: string | null;
  persistedUserMessageContent?: string;
}

async function runWithVisionTurnTimeout<T>({
  channelId,
  deadlineAt,
  stage,
  onTimeout,
  run,
}: {
  channelId: string;
  deadlineAt: number | null;
  stage: string;
  onTimeout?: (() => void) | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  if (deadlineAt == null) {
    return run();
  }

  const remainingMs = deadlineAt - Date.now();
  const timeoutError = new Error(`Vision turn timed out after ${VISION_TURN_TIMEOUT_MS}ms`);
  if (remainingMs <= 0) {
    log.warn('Vision turn exceeded its deadline before stage start', {
      channelId,
      stage,
      timeoutMs: VISION_TURN_TIMEOUT_MS,
    });
    if (onTimeout) {
      try {
        onTimeout();
      } catch (error) {
        log.warn('Vision turn timeout cleanup failed', {
          channelId,
          stage,
          error: toErrorMessage(error),
        });
      }
    }
    throw timeoutError;
  }

  let timeoutHandle!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      log.warn('Vision turn timed out; aborting stage', {
        channelId,
        stage,
        timeoutMs: VISION_TURN_TIMEOUT_MS,
      });
      if (onTimeout) {
        try {
          onTimeout();
        } catch (error) {
          log.warn('Vision turn timeout cleanup failed', {
            channelId,
            stage,
            error: toErrorMessage(error),
          });
        }
      }
      reject(timeoutError);
    }, remainingMs);
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildPromptMessage(
  message: SubstrateMessage,
  speakerRole: 'user' | 'system',
  content: UserMessage['content'],
): UserMessage | SystemNoteMessage {
  if (speakerRole !== 'system') {
    return {
      role: 'user',
      content: formatCurrentTurnUserContentForPrompt(message, content),
      timestamp: Date.now(),
    } satisfies UserMessage;
  }

  if (typeof content !== 'string') {
    return {
      role: 'user',
      content,
      timestamp: Date.now(),
    } satisfies UserMessage;
  }

  return {
    role: 'custom',
    type: 'systemNote',
    messageClass: MESSAGE_CLASSES.systemNote,
    content: formatAttributedSystemContent(content, message.authorName),
    timestamp: Date.now(),
  } satisfies SystemNoteMessage;
}

function shouldRenderCurrentTurnGroupAttribution(message: SubstrateMessage): boolean {
  if (message.isDirectMessage === true) return false;
  if (message.isDirectMessage === false) return true;
  const explicitChannelVisibility = message.routing?.channelPrivacy;
  return explicitChannelVisibility !== undefined && explicitChannelVisibility !== 'private';
}

function formatCurrentTurnUserContentForPrompt(
  message: SubstrateMessage,
  content: UserMessage['content'],
): UserMessage['content'] {
  if (!shouldRenderCurrentTurnGroupAttribution(message)) return content;
  const attribution = {
    authorId: message.authorId,
    authorName: message.authorName,
    source: message.channelType,
  };
  if (typeof content === 'string') {
    return formatGroupUserMessageContent(content, attribution);
  }

  const firstTextIndex = content.findIndex(block => block.type === 'text');
  if (firstTextIndex < 0) {
    return [
      { type: 'text', text: formatGroupUserMessageContent('', attribution) },
      ...content,
    ];
  }

  return content.map((block, index) => {
    if (index !== firstTextIndex || block.type !== 'text') return block;
    return {
      ...block,
      text: formatGroupUserMessageContent(block.text, attribution),
    };
  });
}

function readAssistantReasoning(message: AssistantMessage | null): string | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  const reasoningBlocks: string[] = [];
  for (const block of message.content) {
    if ((block as { type?: unknown }).type !== 'thinking') {
      continue;
    }
    const thinking = (block as { thinking?: unknown }).thinking;
    if (typeof thinking === 'string' && thinking.trim().length > 0) {
      reasoningBlocks.push(thinking.trim());
    }
  }
  const reasoning = reasoningBlocks.join('\n\n');
  return sanitizePersistedReasoningText(reasoning);
}

function countAssistantToolCalls(message: AssistantMessage | null): number | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  const count = message.content.filter((block: unknown) => (
    typeof block === 'object'
    && block !== null
    && (block as { type?: unknown }).type === 'toolCall'
  )).length;
  return count > 0 ? count : undefined;
}

function buildPromptResponseSnapshot(input: {
  assistantMessage: AssistantMessage | null;
  content: string;
  model: string | null;
  stopReason?: string;
}): TurnPromptResponseSnapshot {
  const reasoning = readAssistantReasoning(input.assistantMessage);
  const toolCallCount = countAssistantToolCalls(input.assistantMessage);
  return {
    content: input.content,
    ...(input.model ? { model: input.model } : {}),
    ...(input.assistantMessage?.stopReason
      ? { stopReason: input.assistantMessage.stopReason }
      : input.stopReason
        ? { stopReason: input.stopReason }
        : {}),
    ...(input.assistantMessage?.errorMessage ? { errorMessage: input.assistantMessage.errorMessage } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(toolCallCount !== undefined ? { toolCallCount } : {}),
  };
}

function stringifyPromptContentForSnapshot(
  content: UserMessage['content'],
  persistedUserContent?: string,
): string {
  if (persistedUserContent !== undefined) {
    return persistedUserContent;
  }
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === 'text') {
        return block.text;
      }
      return `[${block.type}]`;
    })
    .join('\n\n');
}

function countImageAttachments(message: SubstrateMessage): number {
  return message.attachments?.filter((attachment) => {
    const type = attachment.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    return type.startsWith('image/')
      || /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i.test(attachment.name)
      || /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i.test(attachment.url);
  }).length ?? 0;
}

function buildVisionUnavailablePromptContent(input: {
  message: SubstrateMessage;
  errorMessage: string;
}): UserMessage['content'] {
  const imageCount = countImageAttachments(input.message);
  const semanticText = input.message.content.trim();
  const note = [
    '[Runtime note]',
    `The current user turn included ${imageCount || 'one or more'} image attachment(s), but runtime image inspection failed for this turn.`,
    'You cannot reliably see the current image contents.',
    'Do not pretend you saw them.',
    'Reply to the user from the text that is available, acknowledge that image inspection failed, and ask them to resend the image if visual details matter.',
    `Runtime failure: ${input.errorMessage}`,
  ].join(' ');

  return semanticText.length > 0
    ? `${note}\n\nUser text: ${semanticText}`
    : note;
}

function buildVisionUnavailableAssistantReply(message: SubstrateMessage): string {
  const hasText = message.content.trim().length > 0;
  if (hasText) {
    return 'I got your message, but my image reader failed before I could inspect the attachment. I can respond to the text, but I should not pretend I saw the image. Please resend it if the visual details matter.';
  }
  return 'I got the image attachment, but my image reader failed before I could inspect it. Please resend it or describe what you want me to check.';
}

function appendRuntimeFallbackAssistantMessage(
  runtime: TurnExecutionRuntime,
  content: string,
): AssistantMessage {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: 'runtime',
    provider: 'runtime',
    model: RUNTIME_FALLBACK_MODEL,
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
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  runtime.agent.appendMessage(message);
  return message;
}

export async function invokeAgentForTurn(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  context: Awaited<ReturnType<TurnExecutionRuntime['sessionManager']['buildContext']>>;
  providerSystemPrompt: string;
  piMessages: ReturnType<typeof contextMessagesToPiMessages>;
  startTime: number;
  promptStageStart: number;
  turnId: TurnID;
  requestId: string;
  taskKind: string | undefined;
  turnCallType: ObservabilityCallType;
  turnCorrelationBase: CorrelationMetadata;
  viewerRequestContext: Partial<CorrelationMetadata>;
  baseVisionToolRequestContext: {
    userMessageText: string;
    imageAttachmentUrls: string[];
  };
  autoloadOutcome: AutoloadTurnOutcome;
  turnSnapshot: TurnSnapshot;
  templateVariables: Record<string, string>;
  speakerRole: 'user' | 'system';
  mutableState: AgentInvocationMutableState;
  observability: Pick<
    TurnExecutionObservability,
    'emitObservedTurnStage' | 'emitTurnSnapshotInBackground' | 'emitTurnSnapshot'
  >;
}): Promise<AgentInvocationResult> {
  const {
    runtime,
    message,
    context,
    providerSystemPrompt,
    piMessages,
    startTime,
    promptStageStart,
    turnId,
    requestId,
    taskKind,
    turnCallType,
    turnCorrelationBase,
    viewerRequestContext,
    baseVisionToolRequestContext,
    autoloadOutcome,
    turnSnapshot,
    templateVariables,
    speakerRole,
    mutableState,
    observability,
  } = input;

  let firstTokenAt: number;
  let turnUsage: TurnUsage;
  let responseText: string;
  let responseModel = runtime.agent.state.model.id;
  let fallbackDiagnostics: AgentResponse['metadata']['diagnostics'] | undefined;
  let runtimeContradictionDiagnostics: NonNullable<AgentResponse['metadata']['diagnostics']> | undefined;
  let runtimeContradictionDiagnostic: RuntimeContradictionDiagnostic | undefined;
  const turnIntent: string | null = autoloadOutcome.intent;
  const isVisionTurn = hasVisionTurnInputs(message);
  const visionTurnDeadlineAt = isVisionTurn ? promptStageStart + VISION_TURN_TIMEOUT_MS : null;

  const moaSettings = resolveMoaSettings(runtime.config, log);
  if (moaSettings) {
    const moaResult = await runWithVisionTurnTimeout({
      channelId: message.channelId,
      deadlineAt: visionTurnDeadlineAt,
      stage: 'moa_turn',
      run: () => runMoaTurn({
        llmClient: runtime.llmClient,
        context,
        message,
        settings: moaSettings,
        config: runtime.config,
        turnId,
        requestId,
        callType: turnCallType,
        contextWindow: runtime.resolveContextWindow(),
        emitTelemetry: (eventName, payload) => runtime.emitTelemetry(eventName, payload),
      }),
    });
    firstTokenAt = Date.now();
    observability.emitObservedTurnStage('first-token', {
      ttftMs: firstTokenAt - startTime,
      source: 'fallback',
    });
    observability.emitObservedTurnStage('prompt', {
      durationMs: Date.now() - promptStageStart,
      ttftMs: firstTokenAt - startTime,
      mode: 'moa',
      rounds: moaResult.rounds,
      stopReason: moaResult.stopReason,
    });
    turnUsage = moaResult.turnUsage;
    responseModel = moaResult.model;
    responseText = moaResult.output;
    if (turnSnapshot.promptContext) {
      turnSnapshot.promptContext.response = {
        content: moaResult.output,
        model: moaResult.model,
        stopReason: moaResult.stopReason,
      };
      turnSnapshot.capturedAt = Date.now();
      observability.emitTurnSnapshotInBackground(turnSnapshot);
    }
    return {
      firstTokenAt,
      turnMessages: mutableState.turnMessages,
      turnUsage,
      responseModel,
      responseText,
      fallbackDiagnostics,
      runtimeContradictionDiagnostics,
      turnIntent,
      ...(isVisionTurn ? { persistedUserMessageContent: buildPersistedVisionUnavailableUserContent(message) } : {}),
    };
  }

  runtime.agent.setSystemPrompt(enforceUntrustedCompactionGuard(providerSystemPrompt));
  const adaptiveToolSnapshot = cloneObservedAdaptiveToolSnapshot(
    runtime.getAdaptiveToolRuntimeState().lastSnapshot,
  );
  const activeTools = readActiveTurnToolSchemas(runtime.agent);
  if (turnSnapshot.plan) {
    // The plan carries exactly what ships to the provider: bind the resolved
    // tool definitions before the snapshot is (re-)emitted and persisted.
    turnSnapshot.plan.toolDefinitions = activeTools;
  }
  if (activeTools.length > 0 || adaptiveToolSnapshot) {
    turnSnapshot.toolContext = {
      activeTools,
      ...(adaptiveToolSnapshot
        ? { adaptiveSnapshot: adaptiveToolSnapshot }
        : {}),
    };
    turnSnapshot.capturedAt = Date.now();
    observability.emitTurnSnapshotInBackground(turnSnapshot);
  }

  const agentMessages: AgentMessage[] = piMessages;
  const historyMessages = agentMessages.length > 0 ? agentMessages.slice(0, -1) : [];
  runtime.agent.replaceMessages(historyMessages);
  mutableState.turnStartMessageIndex = runtime.agent.state.messages.length;

  let streamFirstTokenAt: number | null = null;
  const streamTelemetryBus = runtime.eventBus as unknown as {
    on: (event: string, handler: (data: { channelId: string; text: string }) => void) => () => void;
  };
  const unsubscribeFirstToken = streamTelemetryBus.on('agent.stream.delta', ({ channelId }) => {
    if (channelId !== message.channelId || streamFirstTokenAt != null) return;
    streamFirstTokenAt = Date.now();
    observability.emitObservedTurnStage('first-token', {
      ttftMs: streamFirstTokenAt - startTime,
      source: 'stream',
    });
  });

  const bridgeToken = runtime.bridge.setChannel(message.channelId, {
    turnId,
    requestId,
    callType: turnCallType,
    originType: turnCallType,
    originStage: 'agent.turn.prompt',
    purpose: 'agent.turn.prompt',
  });
  runtime.setActiveTurnContext(turnCorrelationBase, taskKind ?? null, autoloadOutcome.intent);
  let initialBridgeActive = true;
  const clearInitialPromptContext = (): void => {
    if (!initialBridgeActive) return;
    initialBridgeActive = false;
    unsubscribeFirstToken();
    runtime.bridge.clearChannel(bridgeToken);
    runtime.clearActiveTurnContext();
  };
  let promptVisionDeadlineAt = visionTurnDeadlineAt;
  let runtimeFallbackModel: string | null = null;
  let turnUserContentBuildResult: Awaited<ReturnType<typeof buildTurnUserContent>>;
  try {
    turnUserContentBuildResult = await runWithVisionTurnTimeout({
      channelId: message.channelId,
      deadlineAt: visionTurnDeadlineAt,
      stage: 'build_turn_user_content',
      run: () => buildTurnUserContent({
        message,
        llmClient: runtime.llmClient,
        runtimeMode: runtime.runtimeMode,
        logger: log,
        visionReviewer: runtime.imageVisionReviewer,
      }),
    });
  } catch (error) {
    if (!isVisionTurn) {
      clearInitialPromptContext();
      throw error;
    }
    const errorMessage = toErrorMessage(error);
    log.warn('Vision content build failed; falling back to a text-only unavailable-image prompt', {
      channelId: message.channelId,
      channelType: message.channelType,
      error: errorMessage,
    });
    promptVisionDeadlineAt = null;
    fallbackDiagnostics = {
      fallback: {
        code: 'vision_content_unavailable',
        strategy: 'text_only_unavailable_notice',
        attempts: 0,
        finalContentEmpty: false,
        previousErrorMessage: errorMessage,
      },
    };
    turnUserContentBuildResult = {
      content: buildVisionUnavailablePromptContent({
        message,
        errorMessage,
      }),
      persistedUserContent: buildPersistedVisionUnavailableUserContent(message),
    };
  }
  const selfieAppearanceContext = activeTools.some((tool) => tool.name === 'selfie_create')
    ? resolveAppearanceContextFromTemplateVariables(templateVariables)
    : undefined;
  const visionToolRequestContext = {
    ...baseVisionToolRequestContext,
    ...(selfieAppearanceContext !== undefined
      ? { appearanceContext: selfieAppearanceContext }
      : {}),
    ...(turnUserContentBuildResult.currentTurnVisionReview
      ? { currentTurnVisionReview: turnUserContentBuildResult.currentTurnVisionReview }
      : {}),
  };
  if (turnSnapshot.promptContext) {
    turnSnapshot.promptContext.currentTurnInput = stringifyPromptContentForSnapshot(
      turnUserContentBuildResult.content,
      turnUserContentBuildResult.persistedUserContent,
    );
    turnSnapshot.capturedAt = Date.now();
    observability.emitTurnSnapshotInBackground(turnSnapshot);
  }
  try {
    await runWithVisionTurnTimeout({
      channelId: message.channelId,
      deadlineAt: promptVisionDeadlineAt,
      stage: 'agent_prompt',
      onTimeout: () => runtime.agent.abort(),
      run: () => runWithRequestContext(
        {
          ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.prompt'),
          ...viewerRequestContext,
        },
        async () => runWithVisionToolRequestContext(
          visionToolRequestContext,
          async () => runtime.agent.prompt(
            buildPromptMessage(message, speakerRole, turnUserContentBuildResult.content),
          ),
        ),
      ),
    });
  } catch (error) {
    if (!isVisionTurn) {
      throw error;
    }
    const errorMessage = toErrorMessage(error);
    log.warn('Vision prompt failed; emitting non-fabricating runtime fallback reply', {
      channelId: message.channelId,
      channelType: message.channelType,
      error: errorMessage,
    });
    appendRuntimeFallbackAssistantMessage(runtime, buildVisionUnavailableAssistantReply(message));
    runtimeFallbackModel = RUNTIME_FALLBACK_MODEL;
    fallbackDiagnostics = {
      fallback: {
        code: 'vision_prompt_unavailable',
        strategy: 'runtime_nonfabricating_notice',
        attempts: 0,
        finalContentEmpty: false,
        previousErrorMessage: errorMessage,
        runtimeFallbackApplied: true,
      },
    };
  } finally {
    clearInitialPromptContext();
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- closure mutation invisible to narrowing
  if (streamFirstTokenAt == null) {
    streamFirstTokenAt = Date.now();
    observability.emitObservedTurnStage('first-token', {
      ttftMs: streamFirstTokenAt - startTime,
      source: 'fallback',
    });
  }

  mutableState.turnMessages = runtime.agent.state.messages.slice(mutableState.turnStartMessageIndex);
  turnUsage = runtime.accumulateTurnUsage(mutableState.turnMessages);
  responseModel = runtimeFallbackModel ?? runtime.agent.state.model.id;
  firstTokenAt = streamFirstTokenAt;

  responseText = runtime.extractResponseText();
  const runtimeContradictionDetection = detectRuntimeDatetimeContradiction(
    buildRuntimeDatetimeDetectionContext({
      plan: turnSnapshot.plan,
      promptContext: turnSnapshot.promptContext,
    }),
    responseText,
  );
  if (runtimeContradictionDetection.anchorDetected && runtimeContradictionDetection.contradictionDetected) {
    runtimeContradictionDiagnostic = {
      code: 'runtime_datetime_anchor_contradiction',
      anchorDetected: true,
      matchedSignals: [...runtimeContradictionDetection.matchedSignals],
      attempts: 1,
      retryAttempted: true,
      retrySucceeded: false,
      refusalApplied: false,
    };
    runtimeContradictionDiagnostics = {
      runtimeContradiction: runtimeContradictionDiagnostic,
    };
    log.warn('Runtime datetime contradiction detected; retrying with strengthened anchor', {
      channelId: message.channelId,
      matchedSignals: runtimeContradictionDetection.matchedSignals,
    });

    const preRetryTurnUsage = turnUsage;
    const strengthenedSystemPrompt = buildRuntimeDatetimeAnchorRetryPrompt(providerSystemPrompt);
    runtime.agent.replaceMessages(historyMessages);
    runtime.agent.setSystemPrompt(enforceUntrustedCompactionGuard(strengthenedSystemPrompt));

    const contradictionRetryBridgeToken = runtime.bridge.setChannel(message.channelId, {
      turnId,
      requestId: `${requestId}:runtime-contradiction-retry`,
      callType: turnCallType,
      originType: turnCallType,
      originStage: 'agent.turn.runtime_contradiction_retry',
      purpose: 'agent.turn.runtime_contradiction_retry',
    });
    runtime.setActiveTurnContext(turnCorrelationBase, taskKind ?? null, autoloadOutcome.intent);
    try {
      await runWithVisionTurnTimeout({
        channelId: message.channelId,
        deadlineAt: visionTurnDeadlineAt,
        stage: 'agent_turn_runtime_contradiction_retry',
        onTimeout: () => runtime.agent.abort(),
        run: () => runWithRequestContext(
          {
            ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.runtime_contradiction_retry'),
            ...viewerRequestContext,
          },
          async () => runWithVisionToolRequestContext(
            visionToolRequestContext,
            async () => runtime.agent.prompt(
              buildPromptMessage(message, speakerRole, turnUserContentBuildResult.content),
            ),
          ),
        ),
      });
    } finally {
      runtime.bridge.clearChannel(contradictionRetryBridgeToken);
      runtime.clearActiveTurnContext();
    }

    mutableState.turnMessages = runtime.agent.state.messages.slice(mutableState.turnStartMessageIndex);
    const retryTurnUsage = runtime.accumulateTurnUsage(mutableState.turnMessages);
    turnUsage = {
      inputTokens: preRetryTurnUsage.inputTokens + retryTurnUsage.inputTokens,
      outputTokens: preRetryTurnUsage.outputTokens + retryTurnUsage.outputTokens,
      cacheReadTokens: preRetryTurnUsage.cacheReadTokens + retryTurnUsage.cacheReadTokens,
      llmCalls: preRetryTurnUsage.llmCalls + retryTurnUsage.llmCalls,
      toolCalls: preRetryTurnUsage.toolCalls + retryTurnUsage.toolCalls,
      contextUtilization: Math.max(preRetryTurnUsage.contextUtilization, retryTurnUsage.contextUtilization),
      ...(preRetryTurnUsage.estimatedCostUsd !== undefined || retryTurnUsage.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: (preRetryTurnUsage.estimatedCostUsd ?? 0) + (retryTurnUsage.estimatedCostUsd ?? 0) }
        : {}),
    };
    responseModel = runtime.agent.state.model.id;
    responseText = runtime.extractResponseText();

    const retryContradictionDetection = detectRuntimeDatetimeContradiction(
      buildRuntimeDatetimeDetectionContext({
        plan: turnSnapshot.plan,
        promptContext: turnSnapshot.promptContext,
      }),
      responseText,
    );
    if (retryContradictionDetection.contradictionDetected) {
      runtimeContradictionDiagnostic = {
        ...runtimeContradictionDiagnostic,
        attempts: 2,
        retrySucceeded: false,
        refusalApplied: true,
      };
      runtimeContradictionDiagnostics = {
        runtimeContradiction: runtimeContradictionDiagnostic,
      };
      responseText = buildRuntimeDatetimeContradictionRefusal();
    } else {
      runtimeContradictionDiagnostic = {
        ...runtimeContradictionDiagnostic,
        attempts: 2,
        retrySucceeded: true,
        refusalApplied: false,
      };
      runtimeContradictionDiagnostics = {
        runtimeContradiction: runtimeContradictionDiagnostic,
      };
    }
  }
  if (isVisionTurn && responseText.trim().length === 0) {
    const assistantMessage = runtime.getLatestAssistantMessage();
    log.warn('Vision turn produced empty assistant text; attempting non-fabricating recovery replay', {
      channelId: message.channelId,
      model: runtime.agent.state.model.id,
      stopReason: assistantMessage?.stopReason ?? null,
      errorMessage: assistantMessage?.errorMessage ?? null,
    });

    try {
      const recoveryModel = resolveModel(runtime.config, 'chat');
      runtime.agent.setModel(recoveryModel);
      responseModel = recoveryModel.id;
    } catch (error) {
      log.warn('Vision recovery model resolution failed; keeping current model', {
        channelId: message.channelId,
        error: toErrorMessage(error),
      });
    }
    runtime.agent.replaceMessages(historyMessages);
    mutableState.turnStartMessageIndex = runtime.agent.state.messages.length;

    const replayTransportContent = message.content.trim();
    let recoveryAttempts = 0;
    let recoveryErrorMessage: string | undefined;
    const runVisionRecoveryPrompt = async (
      content: UserMessage['content'],
      requestSuffix: string,
      originStage: string,
    ): Promise<void> => {
      const recoveryBridgeToken = runtime.bridge.setChannel(message.channelId, {
        turnId,
        requestId: `${requestId}:${requestSuffix}`,
        callType: turnCallType,
        originType: turnCallType,
        originStage,
        purpose: originStage,
      });
      runtime.setActiveTurnCorrelation(turnCorrelationBase);
      try {
        await runWithVisionTurnTimeout({
          channelId: message.channelId,
          deadlineAt: Date.now() + VISION_TURN_TIMEOUT_MS,
          stage: originStage,
          onTimeout: () => runtime.agent.abort(),
          run: () => runWithRequestContext(
            {
              ...runtime.withCorrelationPurpose(turnCorrelationBase, originStage),
              ...viewerRequestContext,
            },
            async () => runWithVisionToolRequestContext(
              visionToolRequestContext,
              async () => runtime.agent.prompt(buildPromptMessage(message, speakerRole, content)),
            ),
          ),
        });
      } finally {
        runtime.bridge.clearChannel(recoveryBridgeToken);
        runtime.setActiveTurnCorrelation(null);
      }
    };

    try {
      if (replayTransportContent.length > 0) {
        for (let attempt = 1; attempt <= VISION_RECOVERY_REPLAY_MAX_ATTEMPTS; attempt += 1) {
          const isRetry = attempt > 1;
          await runVisionRecoveryPrompt(
            replayTransportContent,
            isRetry ? `vision-recovery-retry-${attempt}` : 'vision-recovery',
            isRetry ? 'agent.turn.vision_recovery_retry' : 'agent.turn.vision_recovery',
          );
          recoveryAttempts += 1;

          mutableState.turnMessages = runtime.agent.state.messages.slice(mutableState.turnStartMessageIndex);
          turnUsage = runtime.accumulateTurnUsage(mutableState.turnMessages);
          responseModel = runtime.agent.state.model.id;
          responseText = runtime.extractResponseText();
          if (responseText.trim().length > 0) {
            break;
          }
          if (attempt < VISION_RECOVERY_REPLAY_MAX_ATTEMPTS) {
            log.warn('Vision recovery replay remained empty; retrying with same transport content', {
              channelId: message.channelId,
              model: runtime.agent.state.model.id,
              attempt,
              maxAttempts: VISION_RECOVERY_REPLAY_MAX_ATTEMPTS,
            });
          }
        }
      } else {
        log.warn('Vision recovery replay skipped because transport-normalized content was empty', {
          channelId: message.channelId,
        });
      }
    } catch (error) {
      recoveryErrorMessage = toErrorMessage(error);
      log.warn('Vision recovery replay failed; applying runtime fallback reply', {
        channelId: message.channelId,
        error: recoveryErrorMessage,
      });
    }

    let runtimeFallbackApplied = false;
    if (responseText.trim().length === 0) {
      log.warn('Vision turn remained empty after non-fabricating recovery replay; applying runtime fallback reply', {
        channelId: message.channelId,
        model: runtime.agent.state.model.id,
      });
      appendRuntimeFallbackAssistantMessage(runtime, buildVisionUnavailableAssistantReply(message));
      runtimeFallbackApplied = true;
      runtimeFallbackModel = RUNTIME_FALLBACK_MODEL;
      mutableState.turnMessages = runtime.agent.state.messages.slice(mutableState.turnStartMessageIndex);
      turnUsage = runtime.accumulateTurnUsage(mutableState.turnMessages);
      responseModel = RUNTIME_FALLBACK_MODEL;
      responseText = runtime.extractResponseText();
    }

    const finalContentEmpty = responseText.trim().length === 0;
    const previousErrorMessage = assistantMessage?.errorMessage ?? recoveryErrorMessage;
    fallbackDiagnostics = {
      fallback: {
        code: 'vision_empty_response',
        strategy: runtimeFallbackApplied ? 'runtime_nonfabricating_notice' : 'replay_transport_content',
        attempts: recoveryAttempts,
        finalContentEmpty,
        ...(assistantMessage?.stopReason ? { previousStopReason: assistantMessage.stopReason } : {}),
        ...(previousErrorMessage ? { previousErrorMessage } : {}),
        ...(runtimeFallbackApplied ? { runtimeFallbackApplied: true } : {}),
      },
    };
    runtime.emitTelemetry('agent.turn.fallback', {
      channelId: message.channelId,
      channelType: message.channelType,
      ...fallbackDiagnostics.fallback,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.fallback'),
    });

  }
  observability.emitObservedTurnStage('prompt', {
    durationMs: Date.now() - promptStageStart,
    ttftMs: streamFirstTokenAt - startTime,
    ...(runtimeContradictionDiagnostic
      ? {
        runtimeContradictionRetry: true,
        runtimeContradictionAttempts: runtimeContradictionDiagnostic.attempts,
      }
      : {}),
  });
  if (turnSnapshot.promptContext) {
    turnSnapshot.promptContext.response = buildPromptResponseSnapshot({
      assistantMessage: runtime.getLatestAssistantMessage(),
      content: responseText,
      model: responseModel,
    });
    turnSnapshot.capturedAt = Date.now();
    await observability.emitTurnSnapshot(turnSnapshot);
  }

  return {
    firstTokenAt,
    turnMessages: mutableState.turnMessages,
    turnUsage,
    responseModel,
    responseText,
    fallbackDiagnostics,
    runtimeContradictionDiagnostics,
    turnIntent,
    ...(turnUserContentBuildResult.persistedUserContent
      ? { persistedUserMessageContent: turnUserContentBuildResult.persistedUserContent }
      : {}),
  };
}

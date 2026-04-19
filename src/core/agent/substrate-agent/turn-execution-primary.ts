import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { UserMessage } from '@mariozechner/pi-ai';
import { enforceUntrustedCompactionGuard } from '../../identity/prompt-composer.js';
import { runWithVisionToolRequestContext, type VisionToolRequestContext } from '../../images/request-context.js';
import { runWithRequestContext } from '../../llm/request-context.js';
import {
  contextMessagesToPiMessages,
  mergeSystemContextIntoSystemPrompt,
} from '../../llm/message-conversion.js';
import { createComponentLogger } from '../../logger.js';
import type {
  AgentResponse,
  CorrelationMetadata,
  ObservabilityCallType,
  SubstrateMessage,
  TurnID,
  TurnUsage,
} from '../../types.js';
import { toErrorMessage } from '../../utils/errors.js';
import type { TurnSnapshot } from '../../turns/snapshot.js';
import { resolveModel } from '../stream-adapter.js';
import {
  cloneObservedAdaptiveToolSnapshot,
  readActiveTurnToolSchemas,
} from './turn-tool-context.js';
import {
  buildTurnUserContent,
  hasVisionTurnInputs,
} from './vision-attachments.js';
import {
  resolveMoaSettings,
  runMoaTurn,
} from './moa-turn.js';
import type { TurnExecutionRuntime } from './turn-execution-runtime.js';

const log = createComponentLogger('SubstrateAgent');

export async function executePrimaryTurn(params: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  context: {
    systemPrompt: string;
    messages: Parameters<typeof contextMessagesToPiMessages>[0];
  };
  startTime: number;
  promptStageStart: number;
  turnId: TurnID;
  requestId: string;
  taskKind: string | undefined;
  turnCallType: ObservabilityCallType;
  turnCorrelationBase: CorrelationMetadata;
  viewerRequestContext: Pick<
    CorrelationMetadata,
    'viewerTrustLevel' | 'viewerChannelVisibility' | 'viewerIsDirectMessage'
  >;
  baseVisionToolRequestContext: VisionToolRequestContext;
  turnSnapshot: TurnSnapshot;
  emitObservedTurnStage: (
    stage: 'first-token' | 'prompt',
    payload: Record<string, unknown>,
  ) => void;
  emitTurnSnapshot: (snapshot: TurnSnapshot) => Promise<void>;
}): Promise<{
  firstTokenAt: number;
  turnMessages: AgentMessage[];
  turnUsage: TurnUsage;
  responseModel: string;
  responseText: string;
  fallbackDiagnostics: AgentResponse['metadata']['diagnostics'] | undefined;
  turnIntent: string | null;
}> {
  const {
    runtime,
    message,
    context,
    startTime,
    promptStageStart,
    turnId,
    requestId,
    taskKind,
    turnCallType,
    turnCorrelationBase,
    viewerRequestContext,
    baseVisionToolRequestContext,
    turnSnapshot,
    emitObservedTurnStage,
    emitTurnSnapshot,
  } = params;

  let firstTokenAt: number;
  let turnMessages: AgentMessage[] = [];
  let turnUsage: TurnUsage;
  let responseModel: string;
  let responseText: string;
  let fallbackDiagnostics: AgentResponse['metadata']['diagnostics'] | undefined;
  let turnIntent: string | null = null;

  const moaSettings = resolveMoaSettings(runtime.config, log);
  if (moaSettings) {
    const moaResult = await runMoaTurn({
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
    });
    firstTokenAt = Date.now();
    emitObservedTurnStage('first-token', {
      ttftMs: firstTokenAt - startTime,
      source: 'fallback',
    });
    emitObservedTurnStage('prompt', {
      durationMs: Date.now() - promptStageStart,
      ttftMs: firstTokenAt - startTime,
      mode: 'moa',
      rounds: moaResult.rounds,
      stopReason: moaResult.stopReason,
    });
    turnUsage = moaResult.turnUsage;
    responseModel = moaResult.model;
    responseText = moaResult.output;
    return {
      firstTokenAt,
      turnMessages,
      turnUsage,
      responseModel,
      responseText,
      fallbackDiagnostics,
      turnIntent,
    };
  }

  const providerSystemPrompt = mergeSystemContextIntoSystemPrompt(
    context.systemPrompt,
    context.messages,
  );
  runtime.agent.setSystemPrompt(enforceUntrustedCompactionGuard(providerSystemPrompt));
  const autoloadOutcome = runtime.preloadExtendedToolsForTurn(message, taskKind, turnCorrelationBase);
  turnIntent = autoloadOutcome.intent;
  runtime.applyActiveToolsToAgentForTurn(
    message,
    taskKind,
    turnCallType,
    turnCorrelationBase,
    autoloadOutcome,
  );
  const adaptiveToolSnapshot = cloneObservedAdaptiveToolSnapshot(
    runtime.getAdaptiveToolRuntimeState().lastSnapshot,
  );
  const activeTools = readActiveTurnToolSchemas(runtime.agent);
  if (activeTools.length > 0 || adaptiveToolSnapshot) {
    turnSnapshot.toolContext = {
      activeTools,
      ...(adaptiveToolSnapshot
        ? { adaptiveSnapshot: adaptiveToolSnapshot }
        : {}),
    };
    turnSnapshot.capturedAt = Date.now();
    await emitTurnSnapshot(turnSnapshot);
  }

  const agentMessages = contextMessagesToPiMessages(context.messages);
  const historyMessages = agentMessages.length > 0 ? agentMessages.slice(0, -1) : [];
  runtime.agent.replaceMessages(historyMessages);
  const turnStartMessageIndex = runtime.agent.state.messages.length;

  let streamFirstTokenAt: number | null = null;
  const streamTelemetryBus = runtime.eventBus as unknown as {
    on: (event: string, handler: (data: { channelId: string; text: string }) => void) => () => void;
  };
  const unsubscribeFirstToken = streamTelemetryBus.on('agent.stream.delta', ({ channelId }) => {
    if (channelId !== message.channelId || streamFirstTokenAt != null) return;
    streamFirstTokenAt = Date.now();
    emitObservedTurnStage('first-token', {
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
  const turnUserContentBuildResult = await buildTurnUserContent({
    message,
    llmClient: runtime.llmClient,
    runtimeMode: runtime.runtimeMode,
    logger: log,
    visionReviewer: runtime.imageVisionReviewer,
  });
  const visionToolRequestContext: VisionToolRequestContext = {
    ...baseVisionToolRequestContext,
    ...(turnUserContentBuildResult.currentTurnVisionReview
      ? { currentTurnVisionReview: turnUserContentBuildResult.currentTurnVisionReview }
      : {}),
  };
  try {
    await runWithRequestContext(
      {
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.prompt'),
        ...viewerRequestContext,
      },
      async () => runWithVisionToolRequestContext(
        visionToolRequestContext,
        async () => runtime.agent.prompt({
          role: 'user',
          content: turnUserContentBuildResult.content,
          timestamp: Date.now(),
        } satisfies UserMessage),
      ),
    );
  } finally {
    unsubscribeFirstToken();
    runtime.bridge.clearChannel(bridgeToken);
    runtime.clearActiveTurnContext();
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- closure mutation invisible to narrowing
  if (streamFirstTokenAt === null) {
    streamFirstTokenAt = Date.now();
    emitObservedTurnStage('first-token', {
      ttftMs: streamFirstTokenAt - startTime,
      source: 'fallback',
    });
  }
  emitObservedTurnStage('prompt', {
    durationMs: Date.now() - promptStageStart,
    ttftMs: streamFirstTokenAt - startTime,
  });

  turnMessages = runtime.agent.state.messages.slice(turnStartMessageIndex);
  turnUsage = runtime.accumulateTurnUsage(turnMessages);
  responseModel = runtime.agent.state.model.id;
  firstTokenAt = streamFirstTokenAt;
  responseText = runtime.extractResponseText();

  if (hasVisionTurnInputs(message) && responseText.trim().length === 0) {
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

    const replayTransportContent = message.content.trim();
    let recoveryAttempts = 0;
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
        await runWithRequestContext(
          {
            ...runtime.withCorrelationPurpose(turnCorrelationBase, originStage),
            ...viewerRequestContext,
          },
          async () => runWithVisionToolRequestContext(
            visionToolRequestContext,
            async () => runtime.agent.prompt({
              role: 'user',
              content,
              timestamp: Date.now(),
            } satisfies UserMessage),
          ),
        );
      } finally {
        runtime.bridge.clearChannel(recoveryBridgeToken);
        runtime.setActiveTurnCorrelation(null);
      }
    };

    if (replayTransportContent.length > 0) {
      await runVisionRecoveryPrompt(
        replayTransportContent,
        'vision-recovery',
        'agent.turn.vision_recovery',
      );
      recoveryAttempts += 1;

      turnMessages = runtime.agent.state.messages.slice(turnStartMessageIndex);
      turnUsage = runtime.accumulateTurnUsage(turnMessages);
      responseModel = runtime.agent.state.model.id;
      responseText = runtime.extractResponseText();

      if (responseText.trim().length === 0) {
        log.warn('Vision recovery replay remained empty; retrying once with same transport content', {
          channelId: message.channelId,
          model: runtime.agent.state.model.id,
        });
        await runVisionRecoveryPrompt(
          replayTransportContent,
          'vision-recovery-retry',
          'agent.turn.vision_recovery_retry',
        );
        recoveryAttempts += 1;

        turnMessages = runtime.agent.state.messages.slice(turnStartMessageIndex);
        turnUsage = runtime.accumulateTurnUsage(turnMessages);
        responseModel = runtime.agent.state.model.id;
        responseText = runtime.extractResponseText();
      }
    } else {
      log.warn('Vision recovery replay skipped because transport-normalized content was empty', {
        channelId: message.channelId,
      });
    }

    const finalContentEmpty = responseText.trim().length === 0;
    fallbackDiagnostics = {
      fallback: {
        code: 'vision_empty_response',
        strategy: 'replay_transport_content',
        attempts: recoveryAttempts,
        finalContentEmpty,
        ...(assistantMessage?.stopReason ? { previousStopReason: assistantMessage.stopReason } : {}),
        ...(assistantMessage?.errorMessage ? { previousErrorMessage: assistantMessage.errorMessage } : {}),
      },
    };
    runtime.emitTelemetry('agent.turn.fallback', {
      channelId: message.channelId,
      channelType: message.channelType,
      ...fallbackDiagnostics.fallback,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.fallback'),
    });

    if (finalContentEmpty) {
      log.warn('Vision turn remained empty after non-fabricating recovery replay', {
        channelId: message.channelId,
        model: runtime.agent.state.model.id,
      });
    }
  }

  return {
    firstTokenAt,
    turnMessages,
    turnUsage,
    responseModel,
    responseText,
    fallbackDiagnostics,
    turnIntent,
  };
}

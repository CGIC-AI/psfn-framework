import { createComponentLogger } from '../../shared/logger.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import {
  buildDeferredToolHandoffMessage,
  DEFERRED_TOOL_HANDOFF_ACTION_KIND,
  normalizeDeferredToolHandoffPayload,
  type DeferredToolHandoffPayload,
} from '../agent/deferred-tool-handoff.js';
import {
  inferComposedDeferredPostTurnActions,
  inferDeferredPostTurnActions as inferDeferredPostTurnActionsFromMessages,
} from '../agent/deferred-post-turn-inference.js';
import { evaluateCompositionalPolicyForChannelId } from '../../system/capabilities/compositional-policy.js';
import {
  SleeptimeMemoryAgent,
  SLEEPTIME_MEMORY_ACTION_KIND,
} from '../../faculties/memory/sleeptime-agent.js';
import {
  IntentionAppraisal,
  INTENTION_FOLLOW_UP_ACTION_KIND,
  INTENTION_REMINDER_ACTION_KIND,
  decisionsToPostTurnActionCandidates,
  isBackgroundAppraisalChannel,
  normalizeIntentionFollowUpActionPayload,
  normalizeIntentionReminderActionPayload,
  pendingFollowUpsToPostTurnActionCandidates,
  sessionEntriesToIntentionMessages,
  toInferredPostTurnActions,
} from '../intention/appraisal.js';
import { MotivationBridge } from '../intention/motivation.js';
import { cloneInternalState } from '../self-model/state.js';
import {
  BACKGROUND_CONTINUATION_RUNTIME_CLASS,
  MAINTENANCE_REFLECTION_RUNTIME_CLASS,
  POST_TURN_APPRAISAL_RUNTIME_CLASS,
} from '../agent/worker-lanes.js';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import type {
  HeartbeatAgent,
  HeartbeatRuntimeOptions,
} from './heartbeat-runtime-contracts.js';
import { DEFERRED_HEARTBEAT_ACTION_KIND } from './heartbeat-runtime-contracts.js';
import type { HeartbeatTemplateRuntime } from './heartbeat-template-runtime.js';

const log = createComponentLogger('HeartbeatPostTurn');

interface WireHeartbeatPostTurnRuntimeOptions {
  agentLoop: HeartbeatAgent;
  sender: MessageSender;
  templateRuntime: Pick<HeartbeatTemplateRuntime, 'runDeferredTemplate'>;
  runtimeOptions?: HeartbeatRuntimeOptions;
}

export function wireHeartbeatPostTurnRuntime(
  options: WireHeartbeatPostTurnRuntimeOptions,
): void {
  const {
    agentLoop,
    sender,
    templateRuntime,
    runtimeOptions = {},
  } = options;

  if (!runtimeOptions.postTurnActions) {
    return;
  }

  const telemetryEventBus = runtimeOptions.eventBus;
  const deferredToolHandoffPayloads = new Map<string, DeferredToolHandoffPayload>();
  const deferredToolHandoffExecutionState = new Map<string, { activated: boolean; executed: boolean }>();
  const shouldUseCompositionalAppraisal = (channelId: string): boolean => (
    evaluateCompositionalPolicyForChannelId({
      policy: runtimeOptions.compositionalPolicy,
      capabilityTier: runtimeOptions.capabilityTier,
      channelId,
      purpose: 'appraisal',
    }).allowed
  );
  const sleeptimeAgent = (
    runtimeOptions.llmProvider
    && runtimeOptions.memoryWriter
    && runtimeOptions.sessionManager
    && runtimeOptions.coreMemoryStore
  )
    ? new SleeptimeMemoryAgent({
      llmProvider: runtimeOptions.llmProvider,
      sessionManager: runtimeOptions.sessionManager,
      coreMemoryStore: runtimeOptions.coreMemoryStore,
      memoryWriter: runtimeOptions.memoryWriter,
      cadenceTurns: runtimeOptions.sleeptimeCadenceTurns,
      restWindow: runtimeOptions.episodicProcessingRestWindow,
      episodicSynthesizer: runtimeOptions.episodicSynthesizer,
    })
    : null;
  const intentionAppraisalEnabled = runtimeOptions.intentionAppraisalEnabled !== false;
  const intentionAppraisal = (
    intentionAppraisalEnabled
    && runtimeOptions.llmProvider
    && telemetryEventBus
  )
    ? new IntentionAppraisal({
      llmProvider: runtimeOptions.llmProvider,
      ...(runtimeOptions.characterPromptVariablesProvider
        ? { characterPromptVariablesProvider: runtimeOptions.characterPromptVariablesProvider }
        : {}),
      onEvaluationError: (error, context) => {
        log.warn('Intention appraisal failed closed', {
          sessionId: context.sessionId,
          trigger: context.trigger,
          error: String(error),
        });
      },
    })
    : null;
  const intentionSessionsInFlight = new Set<string>();
  const motivationBridge = intentionAppraisal ? new MotivationBridge() : null;

  const emitDeferredToolHandoffTelemetry = (
    payload: {
      actionId: string;
      dedupeKey: string;
      channelId: string;
      sourceMessageId: string;
      toolNames: string[];
      intendedAction: string;
      phase: 'queued' | 'activated' | 'executed' | 'failed';
      attempt?: number;
      maxAttempts?: number;
      error?: string;
    },
  ): void => {
    if (!telemetryEventBus) return;
    telemetryEventBus.emit('agent.tool_handoff.telemetry', {
      ...payload,
      timestamp: Date.now(),
    }).catch((error) => {
      log.warn('Deferred tool-handoff telemetry emit failed', {
        actionId: payload.actionId,
        phase: payload.phase,
        error: String(error),
      });
    });
    const adaptiveDecision = payload.phase === 'queued'
      ? 'queued'
      : payload.phase === 'executed'
        ? 'executed'
        : payload.phase === 'failed'
          ? 'failed'
          : null;
    if (!adaptiveDecision) return;
    for (const toolName of payload.toolNames) {
      telemetryEventBus.emit('agent.tools.adaptive.decision', {
        turnId: payload.sourceMessageId || payload.actionId,
        requestId: payload.actionId,
        channelId: payload.channelId,
        callType: 'tool',
        purpose: 'agent.tools.adaptive.decision',
        timestamp: Date.now(),
        toolName,
        source: 'deferred',
        decision: adaptiveDecision,
        reason: payload.phase === 'failed'
          ? 'deferred_tool_handoff_failed'
          : 'deferred_tool_handoff',
        taskKind: 'deferred_tool_handoff',
        intent: 'deferred_tool_handoff',
      }).catch((error) => {
        log.warn('Deferred adaptive tool telemetry emit failed', {
          actionId: payload.actionId,
          toolName,
          phase: payload.phase,
          error: String(error),
        });
      });
    }
  };

  type PostTurnInfererContext = Parameters<PostTurnActionInferer>[0];

  const buildConversationTrajectory = (context: Pick<PostTurnInfererContext, 'message' | 'response'>) => {
    const unresolvedTopics: string[] = [];
    const userText = context.message.content.trim();
    const responseText = context.response.content.trim();
    if (userText.includes('?') && !responseText.endsWith('?')) {
      unresolvedTopics.push(userText.slice(0, 180));
    }

    const summary = `User: ${userText.slice(0, 180)} | Assistant: ${responseText.slice(0, 180)}`;
    return {
      ...(unresolvedTopics.length > 0 ? { unresolvedTopics } : {}),
      summary,
      turnsSinceUserReply: 0,
    };
  };

  const triggerIntentionPostTurnAppraisal = (
    context: Pick<PostTurnInfererContext, 'message' | 'response' | 'canonicalContactKey' | 'completedAt'>,
  ): void => {
    if (!intentionAppraisal || !telemetryEventBus) {
      return;
    }

    const resolvedSessionId = (
      runtimeOptions.sessionManager?.resolveSessionChannelId(context.message.channelId)
      ?? context.message.channelId
    ).trim() || context.message.channelId;

    if (intentionSessionsInFlight.has(resolvedSessionId)) {
      return;
    }
    intentionSessionsInFlight.add(resolvedSessionId);

    void (async () => {
      try {
        const recentSessionEntries = runtimeOptions.sessionManager?.getRecentMessages(resolvedSessionId, 12) ?? [];
        const recentMessages = sessionEntriesToIntentionMessages(recentSessionEntries);
        recentMessages.push({
          role: 'user',
          content: context.message.content,
          timestamp: context.message.timestamp.getTime(),
        });
        const trimmedResponse = context.response.content.trim();
        if (trimmedResponse) {
          recentMessages.push({
            role: 'assistant',
            content: trimmedResponse,
            timestamp: Date.now(),
          });
        }

        if (context.response.metadata.internalState === undefined) {
          throw new Error('Intention post-turn appraisal requires response.metadata.internalState');
        }
        const internalState = cloneInternalState(context.response.metadata.internalState);
        const currentEmotion = {
          vad: { ...internalState.emotional.vad },
          mood: { ...internalState.emotional.mood },
          discrete: { ...internalState.emotional.discreteEmotions },
          confidence: internalState.emotional.confidence,
        };
        if (runtimeOptions.onBehavioralPatternOutcome) {
          try {
            await runtimeOptions.onBehavioralPatternOutcome({
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
              emotionSnapshot: currentEmotion,
              observedAtMs: context.completedAt,
            });
          } catch (error) {
            log.warn('Behavioral pattern outcome hook failed', {
              channelId: context.message.channelId,
              messageId: context.message.id,
              error: String(error),
            });
          }
        }
        const contactEmotionalSnapshot = (
          context.canonicalContactKey
          && runtimeOptions.contactStore?.getEmotionalSnapshot
        )
          ? (await runtimeOptions.contactStore.getEmotionalSnapshot(context.canonicalContactKey)) ?? null
          : null;
        const contactForMotivation = (
          context.canonicalContactKey
          && runtimeOptions.contactStore?.getById
        )
          ? await runtimeOptions.contactStore.getById(context.canonicalContactKey)
          : undefined;
        const isPrimaryContact = contactForMotivation?.trustLevel === 'primary';
        const motivationAssessment = motivationBridge?.assess({
          sessionId: resolvedSessionId,
          currentEmotion,
          contactEmotionalSnapshot,
          isPrimaryContact,
        });
        if (motivationAssessment?.shouldTriggerAppraisal) {
          log.debug('Motivation bridge trigger matched', {
            sessionId: resolvedSessionId,
            profile: motivationAssessment.profile,
            signals: motivationAssessment.signals.map(signal => signal.kind),
            metrics: motivationAssessment.metrics,
          });
        }
        const activeConcerns = runtimeOptions.getActiveConcerns
          ? await Promise.resolve(
            runtimeOptions.getActiveConcerns({
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
            }),
          )
          : undefined;
        const recentlyResolvedConcerns = runtimeOptions.getRecentResolvedConcerns
          ? await Promise.resolve(
            runtimeOptions.getRecentResolvedConcerns({
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
            }),
          )
          : undefined;
        const decisions = await intentionAppraisal.evaluate({
          sessionId: resolvedSessionId,
          internalState,
          currentEmotion,
          recentMessages,
          ...(activeConcerns ? { activeConcerns } : {}),
          ...(recentlyResolvedConcerns ? { recentlyResolvedConcerns } : {}),
          contactEmotionalSnapshot,
          conversationTrajectory: buildConversationTrajectory(context),
          ...(motivationAssessment?.shouldTriggerAppraisal
            ? {
              triggerOverride: 'motivation' as const,
              motivationSignals: motivationAssessment.signals.map(signal => signal.kind),
            }
            : {}),
        });

        if (runtimeOptions.onIntentionConcernDecision) {
          for (const decision of decisions) {
            if (decision.type !== 'concern') continue;
            await runtimeOptions.onIntentionConcernDecision({
              decision,
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
            });
          }
        }
        if (runtimeOptions.onIntentionFollowUpDecision) {
          for (const decision of decisions) {
            if (decision.type !== 'followUp') continue;
            const pendingFollowUpId = await runtimeOptions.onIntentionFollowUpDecision({
              decision,
              channelId: resolvedSessionId,
              channelType: context.message.channelType,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
            });
            if (pendingFollowUpId) {
              if (!decision.followUp) {
                continue;
              }
              decision.followUp = {
                ...decision.followUp,
                pendingFollowUpId,
              };
            }
          }
        }
        if (runtimeOptions.onIntentionReminderDecision) {
          for (const decision of decisions) {
            if (decision.type !== 'reminder') continue;
            const reminderId = await runtimeOptions.onIntentionReminderDecision({
              decision,
              channelId: resolvedSessionId,
              channelType: context.message.channelType,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
            });
            if (reminderId) {
              if (!decision.reminder) {
                continue;
              }
              decision.reminder = {
                ...decision.reminder,
                reminderId,
              };
            }
          }
        }

        const decisionCandidates = decisionsToPostTurnActionCandidates(
          decisions,
          {
            message: context.message,
          },
          isBackgroundAppraisalChannel(context.message.channelId)
            ? { surfacePendingFollowUpsImmediately: true }
            : {},
        );
        const resurfacedPendingFollowUps = runtimeOptions.getPendingFollowUpsForResurfacing
          ? await runtimeOptions.getPendingFollowUpsForResurfacing({
            channelId: resolvedSessionId,
            canonicalContactKey: context.canonicalContactKey,
            sourceMessageId: context.message.id,
            isBackgroundTurn: isBackgroundAppraisalChannel(context.message.channelId),
            now: Date.now(),
            ...(motivationAssessment?.signals.length
              ? {
                motivationSignals: motivationAssessment.signals.map(signal => signal.kind),
              }
              : {}),
            currentMoodValence: currentEmotion.mood.valence,
          })
          : [];
        const candidates = [
          ...decisionCandidates,
          ...pendingFollowUpsToPostTurnActionCandidates(resurfacedPendingFollowUps),
        ];
        if (candidates.length === 0) {
          return;
        }

        const inferredActions = toInferredPostTurnActions(candidates, context.message);
        if (inferredActions.length === 0) {
          return;
        }

        await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
          message: context.message,
          response: context.response,
          actions: inferredActions,
        });
      } catch (error) {
        log.warn('Intention post-turn appraisal dispatch failed', {
          channelId: context.message.channelId,
          messageId: context.message.id,
          error: String(error),
        });
      } finally {
        intentionSessionsInFlight.delete(resolvedSessionId);
      }
    })();
  };

  telemetryEventBus?.on('agent.post_turn.action.telemetry', (telemetry) => {
    if (telemetry.actionKind !== DEFERRED_TOOL_HANDOFF_ACTION_KIND) {
      return;
    }

    const payload = deferredToolHandoffPayloads.get(telemetry.dedupeKey);
    if (!payload) {
      return;
    }

    if (telemetry.phase === 'queued') {
      emitDeferredToolHandoffTelemetry({
        actionId: telemetry.actionId,
        dedupeKey: telemetry.dedupeKey,
        channelId: telemetry.channelId,
        sourceMessageId: telemetry.sourceMessageId,
        toolNames: payload.toolNames,
        intendedAction: payload.intendedAction,
        phase: 'queued',
        attempt: telemetry.attempt,
        maxAttempts: telemetry.maxAttempts,
      });
    } else if (telemetry.phase === 'failed') {
      emitDeferredToolHandoffTelemetry({
        actionId: telemetry.actionId,
        dedupeKey: telemetry.dedupeKey,
        channelId: telemetry.channelId,
        sourceMessageId: telemetry.sourceMessageId,
        toolNames: payload.toolNames,
        intendedAction: payload.intendedAction,
        phase: 'failed',
        attempt: telemetry.attempt,
        maxAttempts: telemetry.maxAttempts,
        ...(telemetry.error ? { error: telemetry.error } : {}),
      });
      deferredToolHandoffExecutionState.delete(telemetry.dedupeKey);
      deferredToolHandoffPayloads.delete(telemetry.dedupeKey);
    } else if (telemetry.phase === 'succeeded') {
      deferredToolHandoffExecutionState.delete(telemetry.dedupeKey);
      deferredToolHandoffPayloads.delete(telemetry.dedupeKey);
    }
  });

  runtimeOptions.postTurnActions.registerHandler(
    DEFERRED_TOOL_HANDOFF_ACTION_KIND,
    async (action) => {
      const payload = normalizeDeferredToolHandoffPayload(action.payload);
      if (!payload) {
        throw new Error(`Deferred tool handoff action "${action.id}" is missing required payload fields`);
      }
      deferredToolHandoffPayloads.set(action.dedupeKey, payload);

      const executionState = deferredToolHandoffExecutionState.get(action.dedupeKey) ?? {
        activated: false,
        executed: false,
      };

      if (!executionState.activated) {
        const activation = agentLoop.activateExtendedTools?.(payload.toolNames, {
          source: 'deferred',
          correlation: {
            turnId: action.sourceMessageId || action.id,
            requestId: action.id,
            channelId: action.channelId,
            callType: 'tool',
            purpose: 'agent.tools.adaptive.decision',
          },
          taskKind: 'deferred_tool_handoff',
          intent: 'deferred_tool_handoff',
        });
        if (!activation) {
          throw new Error('Agent loop does not support deferred tool activation');
        }
        if (activation.activatedTools.length === 0) {
          throw new Error(
            `Deferred tool handoff action "${action.id}" could not activate tools: ${payload.toolNames.join(', ')}`,
          );
        }
        executionState.activated = true;
        emitDeferredToolHandoffTelemetry({
          actionId: action.id,
          dedupeKey: action.dedupeKey,
          channelId: action.channelId,
          sourceMessageId: action.sourceMessageId,
          toolNames: payload.toolNames,
          intendedAction: payload.intendedAction,
          phase: 'activated',
        });
        deferredToolHandoffExecutionState.set(action.dedupeKey, executionState);
      }

      if (executionState.executed) {
        return;
      }

      const response = await agentLoop.handleMessage(buildDeferredToolHandoffMessage(action.id, payload));
      const responseText = response.content.trim();
      if (responseText && !payload.turn.channelId.startsWith('internal:')) {
        await sender.send(payload.turn.channelId, responseText);
      }

      executionState.executed = true;
      deferredToolHandoffExecutionState.set(action.dedupeKey, executionState);
      emitDeferredToolHandoffTelemetry({
        actionId: action.id,
        dedupeKey: action.dedupeKey,
        channelId: action.channelId,
        sourceMessageId: action.sourceMessageId,
        toolNames: payload.toolNames,
        intendedAction: payload.intendedAction,
        phase: 'executed',
      });
    },
    {
      executionMode: 'background',
      runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS,
    },
  );

  runtimeOptions.postTurnActions.registerHandler(
    DEFERRED_HEARTBEAT_ACTION_KIND,
    async (action) => {
      const templateIdRaw = action.payload.templateId;
      if (typeof templateIdRaw !== 'string' || !templateIdRaw.trim()) {
        throw new Error(`Deferred heartbeat action "${action.id}" is missing payload.templateId`);
      }
      const sendToDiscordOverride = typeof action.payload.sendToDiscordOverride === 'boolean'
        ? action.payload.sendToDiscordOverride
        : undefined;
      await templateRuntime.runDeferredTemplate(templateIdRaw.trim(), {
        ...(sendToDiscordOverride !== undefined ? { sendToDiscordOverride } : {}),
        actionId: action.id,
      });
    },
    {
      runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
    },
  );

  if (intentionAppraisal) {
    if (agentLoop.followUp) {
      runtimeOptions.postTurnActions.registerHandler(
        INTENTION_FOLLOW_UP_ACTION_KIND,
        async (action) => {
          const payload = normalizeIntentionFollowUpActionPayload(action.payload);
          if (!payload) {
            throw new Error(`Intention follow-up action "${action.id}" payload is missing required fields`);
          }
          if (payload.pendingFollowUpId && runtimeOptions.onIntentionFollowUpActivated) {
            const activated = await runtimeOptions.onIntentionFollowUpActivated({
              pendingFollowUpId: payload.pendingFollowUpId,
              activationReason: 'post_turn_action',
            });
            if (activated === false) {
              return;
            }
          }
          agentLoop.followUp?.({
            id: `intention-follow-up:${action.id}`,
            channelId: payload.channelId,
            channelType: payload.channelType,
            authorId: payload.authorId,
            authorName: payload.authorName,
            content: payload.content,
            timestamp: new Date(),
          });
        },
        {
          executionMode: 'background',
          runtimeClass: POST_TURN_APPRAISAL_RUNTIME_CLASS,
        },
      );
      runtimeOptions.postTurnActions.registerHandler(
        INTENTION_REMINDER_ACTION_KIND,
        async (action) => {
          const payload = normalizeIntentionReminderActionPayload(action.payload);
          if (!payload) {
            throw new Error(`Intention reminder action "${action.id}" payload is missing required fields`);
          }
          if (!runtimeOptions.onIntentionReminderTriggered) {
            throw new Error('Intention reminder action triggered without reminder substrate wiring');
          }
          const triggered = await runtimeOptions.onIntentionReminderTriggered({
            reminderId: payload.reminderId,
          });
          if (!triggered) {
            return;
          }
          if (triggered.nextDueAt && telemetryEventBus) {
            const nextRunAt = Date.parse(triggered.nextDueAt);
            if (Number.isFinite(nextRunAt) && nextRunAt > 0) {
              const nextActions = toInferredPostTurnActions([{
                kind: INTENTION_REMINDER_ACTION_KIND,
                dedupeKey: `${INTENTION_REMINDER_ACTION_KIND}:${triggered.reminderId}:${nextRunAt}`,
                payload: {
                  reminderId: triggered.reminderId,
                },
                maxRetries: 1,
                runAt: nextRunAt,
              }], {
                id: action.id,
                channelId: action.channelId,
              });
              if (nextActions.length > 0) {
                await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
                  message: {
                    id: action.id,
                    channelId: action.channelId,
                    channelType: triggered.channelType,
                    authorId: triggered.authorId,
                    authorName: triggered.authorName,
                    content: triggered.content,
                    timestamp: new Date(),
                  },
                  response: {
                    content: triggered.content,
                    channelId: action.channelId,
                    metadata: {
                      model: 'scheduler:reminder-reschedule',
                      inputTokens: 0,
                      outputTokens: 0,
                      durationMs: 0,
                    },
                  },
                  actions: nextActions,
                });
              }
            }
          }
          agentLoop.followUp?.({
            id: `intention-reminder:${action.id}`,
            channelId: triggered.channelId,
            channelType: triggered.channelType,
            authorId: triggered.authorId,
            authorName: triggered.authorName,
            content: triggered.content,
            timestamp: new Date(),
          });
        },
        {
          executionMode: 'background',
          runtimeClass: POST_TURN_APPRAISAL_RUNTIME_CLASS,
        },
      );
    } else {
      log.warn('Intention appraisal enabled but followUp hook is unavailable on agent loop');
    }
  }

  if (sleeptimeAgent) {
    runtimeOptions.postTurnActions.registerHandler(
      SLEEPTIME_MEMORY_ACTION_KIND,
      async (action) => {
        await sleeptimeAgent.execute(action);
      },
      {
        executionMode: 'background',
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      },
    );
  } else {
    log.info('Sleeptime memory agent wiring skipped: missing post-turn dependencies', {
      hasPostTurnActions: Boolean(runtimeOptions.postTurnActions),
      hasLLMProvider: Boolean(runtimeOptions.llmProvider),
      hasMemoryWriter: Boolean(runtimeOptions.memoryWriter),
      hasSessionManager: Boolean(runtimeOptions.sessionManager),
      hasCoreMemoryStore: Boolean(runtimeOptions.coreMemoryStore),
    });
  }

  if (agentLoop.registerPostTurnActionInferer) {
    const inferDeferredPostTurnActions: PostTurnActionInferer = async ({
      message,
      response,
      turnMessages,
      canonicalContactKey,
    }) => {
      const inferred = shouldUseCompositionalAppraisal(message.channelId)
        ? await inferComposedDeferredPostTurnActions({
          message,
          turnMessages,
          deferredHeartbeatActionKind: DEFERRED_HEARTBEAT_ACTION_KIND,
          onDeferredToolHandoffPayload: (dedupeKey, payload) => {
            deferredToolHandoffPayloads.set(dedupeKey, payload);
          },
        })
        : inferDeferredPostTurnActionsFromMessages({
          message,
          turnMessages,
          deferredHeartbeatActionKind: DEFERRED_HEARTBEAT_ACTION_KIND,
          onDeferredToolHandoffPayload: (dedupeKey, payload) => {
            deferredToolHandoffPayloads.set(dedupeKey, payload);
          },
        });
      if (sleeptimeAgent) {
        inferred.push(...sleeptimeAgent.inferPostTurnActions({ message }));
      }
      triggerIntentionPostTurnAppraisal({
        message,
        response,
        canonicalContactKey,
        completedAt: Date.now(),
      });
      return inferred;
    };
    agentLoop.registerPostTurnActionInferer(inferDeferredPostTurnActions);
  } else {
    log.warn('Post-turn action runtime enabled but inferer registration is unavailable');
  }
}

// ── Temporal wake-up lane (E7.1) ──
// Morning wake + latest-only active-turn temporal frame, extracted from
// agent/main.ts (charter 12.1 god-file split, emh3p.1). Morning notes persist
// only after model delivery; idle frames are ephemeral prompt context. The
// catch-up summary reuses the SHARED session
// summarization service (summarizeRecentSessionEntries, purpose 'wake_session');
// outward messages ride the existing proactive-outbound dispatcher and
// quiet-hours time gate.

import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { ProactiveOutboundDispatcher } from '../../../core/intention/proactive-outbound.js';
import {
  registerTemporalWakeupTasks,
  TEMPORAL_WAKEUP_MORNING_TASK_NAME,
  type TemporalWakeupRuntimeOptions,
} from '../../../core/scheduler/temporal-wakeup.js';
import { REFLECTION_SILENT_TOKEN } from '../../../core/scheduler/reflection-policy.js';
import { summarizeRecentSessionEntries } from '../../../core/session/manager/compaction-service.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { ChannelType } from '../../../shared/contracts/runtime.js';

export interface TemporalWakeupLaneDeps {
  scheduler: TemporalWakeupRuntimeOptions['scheduler'];
  sessionManager: TemporalWakeupRuntimeOptions['sessionManager'];
  config: TemporalWakeupRuntimeOptions['config'];
  quietHours: TemporalWakeupRuntimeOptions['quietHours'];
  eventBus: EventBus;
  agentLoop: SubstrateAgent;
  llmProvider: LLMProviderPort;
  promptRegistry: PromptRegistryStatePort | null;
  proactiveOutbound: ProactiveOutboundDispatcher | null;
  companionName: string;
  fleetScheduleStagger?: TemporalWakeupRuntimeOptions['fleetScheduleStagger'];
}

export function buildTemporalWakeTurnPrompt(note: string): string {
  return [
    'Here is the current temporal frame for this morning wake turn:',
    '',
    note,
    '',
    'If you want to send your partner an outward message right now, reply with',
    'only that message. If you have nothing you want to send outward, reply with',
    `"${REFLECTION_SILENT_TOKEN}" — staying quiet is completely fine; nothing about`,
    'this wake requires an outward response.',
  ].join('\n');
}

export function registerTemporalWakeupLane(deps: TemporalWakeupLaneDeps): void {
  const {
    scheduler,
    sessionManager,
    config,
    quietHours,
    eventBus,
    agentLoop,
    llmProvider,
    promptRegistry,
    proactiveOutbound,
    companionName,
    fleetScheduleStagger,
  } = deps;

  registerTemporalWakeupTasks({
    scheduler,
    sessionManager,
    config,
    quietHours,
    ...(fleetScheduleStagger ? { fleetScheduleStagger } : {}),
    // Surface how the morning wake slot was resolved (E7.2): fixed, habit
    // estimate, or habit fallback with a reason. Typed event + Garden read route.
    onWakeTimingResolved: (snapshot) => {
      void eventBus.emit('scheduler.wake_timing.resolved', {
        timingMode: snapshot.timingMode,
        source: snapshot.source,
        effectiveLocalTime: snapshot.effective.localTime,
        timeZone: snapshot.timeZone,
        sampleDays: snapshot.sampleDays,
        ...(snapshot.fallbackReason ? { fallbackReason: snapshot.fallbackReason } : {}),
        ...(snapshot.window
          ? {
            windowStartLocalTime: snapshot.window.startLocalTime,
            windowEndLocalTime: snapshot.window.endLocalTime,
          }
          : {}),
      });
    },
    summarizeCatchUp: async ({ channelId, entries }) => summarizeRecentSessionEntries({
      channelId,
      entries,
      characterName: companionName,
      llmProvider,
      promptRegistry,
      maxTokens: config.morningWake.catchUpSummaryMaxTokens,
      purpose: 'wake_session',
    }),
    invokeWakeTurn: async ({ note }) => {
      const response = await agentLoop.handleMessage({
        id: `reflection-temporal-wakeup-${Date.now()}`,
        channelId: 'internal:reflection:temporal-wakeup',
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: TEMPORAL_WAKEUP_MORNING_TASK_NAME,
        content: buildTemporalWakeTurnPrompt(note),
        timestamp: new Date(),
      });
      const trimmed = response.content.trim();
      const isSilentReflection = !trimmed.toLowerCase().localeCompare(
        REFLECTION_SILENT_TOKEN,
      );
      if (!trimmed || isSilentReflection) {
        return null;
      }
      return trimmed;
    },
    ...(proactiveOutbound
      ? {
        dispatchOutbound: async ({ channelId, channelType, content }: {
          channelId: string;
          channelType: ChannelType;
          content: string;
        }) => proactiveOutbound.dispatch({
          actionId: `temporal-wakeup-${Date.now()}`,
          channelId,
          channelType,
          content,
          reason: 'temporal_wakeup_morning',
        }),
      }
      : {}),
  });
}

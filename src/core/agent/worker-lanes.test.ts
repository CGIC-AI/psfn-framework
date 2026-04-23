import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_CONTINUATION_RUNTIME_CLASS,
  FOREGROUND_CHAT_RUNTIME_CLASS,
  MAINTENANCE_REFLECTION_RUNTIME_CLASS,
  POST_TURN_APPRAISAL_RUNTIME_CLASS,
  SUBAGENT_WORKER_LANE,
  SUBCONSCIOUS_WORKER_PROFILE_CLASS,
  TASK_FOCUSED_WORKER_PROFILE_CLASS,
  WHISPER_WORKER_LANE,
  compareRuntimeLanePriority,
  createWorkerExecutionPolicy,
  isRuntimeLaneClass,
  isSubagentWorkerLane,
  isWhisperWorkerLane,
  resolveRuntimeLaneBudgetProfile,
  resolveRuntimeLaneClassForModelCall,
  resolveRuntimeLaneClassForPostTurnActionKind,
  resolveRuntimeLaneClassForTurn,
  resolveWorkerProfileClassForLane,
} from './worker-lanes.js';

describe('worker lanes', () => {
  it('keeps task-focused subagents separate from the whisper metacognitive lane', () => {
    expect(SUBAGENT_WORKER_LANE).toBe('subagent');
    expect(WHISPER_WORKER_LANE).toBe('whisper');
    expect(isSubagentWorkerLane(SUBAGENT_WORKER_LANE)).toBe(true);
    expect(isSubagentWorkerLane(WHISPER_WORKER_LANE)).toBe(false);
    expect(isWhisperWorkerLane(WHISPER_WORKER_LANE)).toBe(true);
    expect(isWhisperWorkerLane(SUBAGENT_WORKER_LANE)).toBe(false);
  });

  it('maps worker lanes to explicit execution profiles and purpose slots', () => {
    expect(resolveWorkerProfileClassForLane(SUBAGENT_WORKER_LANE)).toBe(TASK_FOCUSED_WORKER_PROFILE_CLASS);
    expect(resolveWorkerProfileClassForLane(WHISPER_WORKER_LANE)).toBe(SUBCONSCIOUS_WORKER_PROFILE_CLASS);

    expect(createWorkerExecutionPolicy(SUBAGENT_WORKER_LANE)).toEqual({
      lane: 'subagent',
      profileClass: 'task_focused',
      modelPurpose: 'background',
      failClosed: true,
    });
    expect(createWorkerExecutionPolicy(WHISPER_WORKER_LANE)).toEqual({
      lane: 'whisper',
      profileClass: 'subconscious',
      modelPurpose: 'memory',
      failClosed: true,
    });
  });

  it('classifies runtime cognition into explicit foreground, appraisal, continuation, and maintenance classes', () => {
    expect(isRuntimeLaneClass(FOREGROUND_CHAT_RUNTIME_CLASS)).toBe(true);
    expect(isRuntimeLaneClass('not-a-runtime-class')).toBe(false);

    expect(resolveRuntimeLaneClassForTurn({
      callType: 'chat',
      channelId: 'terminal:session-a',
    })).toBe(FOREGROUND_CHAT_RUNTIME_CLASS);
    expect(resolveRuntimeLaneClassForTurn({
      callType: 'background',
      channelId: 'terminal:session-a',
      deferredContinuationId: 'action-1',
    })).toBe(BACKGROUND_CONTINUATION_RUNTIME_CLASS);
    expect(resolveRuntimeLaneClassForTurn({
      callType: 'scheduled',
      channelId: 'internal:reflection:musing',
      taskKind: 'reflection',
    })).toBe(MAINTENANCE_REFLECTION_RUNTIME_CLASS);

    expect(resolveRuntimeLaneClassForPostTurnActionKind('intention.follow_up')).toBe(
      POST_TURN_APPRAISAL_RUNTIME_CLASS,
    );
    expect(resolveRuntimeLaneClassForPostTurnActionKind('tool_handoff.continue')).toBe(
      BACKGROUND_CONTINUATION_RUNTIME_CLASS,
    );
    expect(resolveRuntimeLaneClassForPostTurnActionKind('heartbeat.run_template')).toBe(
      MAINTENANCE_REFLECTION_RUNTIME_CLASS,
    );
  });

  it('maps model-bound work into explicit runtime classes for contention control', () => {
    expect(resolveRuntimeLaneClassForModelCall({
      purpose: 'chat',
      callType: 'chat',
      originStage: 'agent.turn.prompt',
    })).toBe(FOREGROUND_CHAT_RUNTIME_CLASS);
    expect(resolveRuntimeLaneClassForModelCall({
      purpose: 'reasoning',
      callType: 'tool',
      originStage: 'repl.think.tool',
    })).toBe(FOREGROUND_CHAT_RUNTIME_CLASS);
    expect(resolveRuntimeLaneClassForModelCall({
      purpose: 'summary',
      callType: 'summary',
      originStage: 'session.compaction.summary',
    })).toBe(POST_TURN_APPRAISAL_RUNTIME_CLASS);
    expect(resolveRuntimeLaneClassForModelCall({
      purpose: 'background',
      callType: 'background',
      originStage: 'tool_handoff.continue',
    })).toBe(BACKGROUND_CONTINUATION_RUNTIME_CLASS);
    expect(resolveRuntimeLaneClassForModelCall({
      purpose: 'memory',
      callType: 'memory',
      channelId: 'internal:heartbeat',
      originStage: 'memory.sleeptime.run',
    })).toBe(MAINTENANCE_REFLECTION_RUNTIME_CLASS);
    expect(resolveRuntimeLaneClassForModelCall({
      purpose: 'reasoning',
      callType: 'background',
      originStage: 'heartbeat.deliberation.voice.reasoning',
    })).toBe(MAINTENANCE_REFLECTION_RUNTIME_CLASS);
  });

  it('assigns bounded priorities, budgets, and degradation rules per runtime class', () => {
    expect(compareRuntimeLanePriority(
      FOREGROUND_CHAT_RUNTIME_CLASS,
      MAINTENANCE_REFLECTION_RUNTIME_CLASS,
    )).toBeLessThan(0);

    expect(resolveRuntimeLaneBudgetProfile(FOREGROUND_CHAT_RUNTIME_CLASS)).toEqual({
      runtimeClass: 'foreground_chat',
      priority: 0,
      chargeLane: 'interactive',
      modelPurpose: 'chat',
      maxQueuedActions: 0,
      maxRunsPerSchedulerTick: 0,
      maxPendingSessionDeliveries: 0,
      maxDeliveriesPerForegroundTurn: 0,
      requiresForegroundIdle: false,
      degradationMode: 'preserve_foreground',
    });
    expect(resolveRuntimeLaneBudgetProfile(POST_TURN_APPRAISAL_RUNTIME_CLASS)).toMatchObject({
      priority: 1,
      chargeLane: 'background',
      maxQueuedActions: 12,
      maxRunsPerSchedulerTick: 2,
      degradationMode: 'drop_oldest_queued',
    });
    expect(resolveRuntimeLaneBudgetProfile(BACKGROUND_CONTINUATION_RUNTIME_CLASS)).toMatchObject({
      priority: 2,
      chargeLane: 'background',
      maxPendingSessionDeliveries: 2,
      maxDeliveriesPerForegroundTurn: 1,
      degradationMode: 'deliver_on_next_foreground_turn',
    });
    expect(resolveRuntimeLaneBudgetProfile(MAINTENANCE_REFLECTION_RUNTIME_CLASS)).toMatchObject({
      priority: 3,
      chargeLane: 'maintenance',
      maxQueuedActions: 3,
      maxRunsPerSchedulerTick: 1,
      requiresForegroundIdle: true,
      degradationMode: 'defer_until_idle',
    });
  });
});

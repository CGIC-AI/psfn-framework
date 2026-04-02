import type { Scheduler } from './scheduler.js';
import type { MessageSender } from '../lifecycle/notifications.js';
import { createComponentLogger } from '../logger.js';
import {
  HEARTBEAT_SILENT_REFLECTION_TOKEN,
  getHeartbeatTemplateAuditProfile,
  HeartbeatPolicyStore,
  type HeartbeatPolicy,
  type ReflectionTemplate,
} from './heartbeat-policy.js';
import { ValuesJournalStore } from '../values/store.js';
import type { ValuesDeliberationMetadata } from '../values/store.js';
import type { PostTurnActionCandidate } from '../types.js';
import type {
  HeartbeatAgent,
  HeartbeatRunTemplateResult,
  HeartbeatRuntimeOptions,
} from './heartbeat-runtime.js';
import { DEFERRED_HEARTBEAT_ACTION_KIND } from './heartbeat-runtime.js';
import {
  resolveHeartbeatPolicyPath,
  resolveLegacyValuesJournalPath,
  resolveReflectionDailyJournalsDir,
  resolveReflectionJournalPath,
  resolveReflectionProcessLogsDir,
  resolveValuesJournalPath,
} from '../persistence/layout.js';
import {
  NON_CANONICAL_REFLECTION_SUBSTRATE,
  ReflectionJournalStore,
} from '../notes/reflection-journal.js';
import {
  assembleReflectionSubstrateContext,
  buildReflectionProcessId,
  ReflectionDailyJournalStore,
  ReflectionProcessLogStore,
} from '../notes/reflection-substrate.js';
import { isBusyTurnError } from '../lifecycle/turn-contention.js';
import { runDeliberation } from '../llm/deliberation.js';
import type { DeliberationResult } from '../llm/deliberation.js';
import {
  buildInternalStateSnapshotRef,
  cloneInternalState,
  serializeInternalState,
  type InternalState,
} from '../self-model/state.js';
import {
  WHISPER_WORKER_LANE,
  createWorkerExecutionPolicy,
} from '../agent/worker-lanes.js';

const log = createComponentLogger('HeartbeatTemplates');

const DEFERRED_REFLECTION_TASK_PREFIX = 'reflection:deferred:';
const MIN_SCHEDULED_TEMPLATE_GAP_MS = 60_000;
const TEMPLATE_EXECUTION_BURST_WINDOW_MS = 60_000;
const TEMPLATE_EXECUTION_BURST_LIMIT = 4;
const TEMPLATE_EXECUTION_COOLDOWN_MS = 10 * 60_000;

interface ReflectionMetacognitiveFlag {
  flag: string;
  confidence: number;
  evidence?: string;
}

interface ReflectionInternalStateContext {
  internalState: InternalState;
  internalStateSnapshotRef: string;
  metacognitiveFlags: ReflectionMetacognitiveFlag[];
}

interface ReflectionSubstratePromptContext {
  canonicalTruthBoundary: typeof NON_CANONICAL_REFLECTION_SUBSTRATE;
  promptBlock: string;
  provenanceRefs: string[];
}

type HeartbeatExecutionSource = 'manual' | 'scheduled' | 'deferred_scheduler' | 'deferred_post_turn';

class HeartbeatTemplateLoopGuardError extends Error {
  readonly templateId: string;
  readonly source: HeartbeatExecutionSource;
  readonly cooldownUntil: number;

  constructor(
    templateId: string,
    source: HeartbeatExecutionSource,
    cooldownUntil: number,
    message: string,
  ) {
    super(message);
    this.name = 'HeartbeatTemplateLoopGuardError';
    this.templateId = templateId;
    this.source = source;
    this.cooldownUntil = cooldownUntil;
  }
}

function isHeartbeatTemplateLoopGuardError(
  error: unknown,
): error is HeartbeatTemplateLoopGuardError {
  return error instanceof HeartbeatTemplateLoopGuardError;
}

export interface HeartbeatTemplateRuntime {
  policyStore: HeartbeatPolicyStore;
  valuesJournal: ValuesJournalStore;
  initialPolicy: HeartbeatPolicy;
  runTemplateNow(
    templateId: string,
    options?: { sendToDiscordOverride?: boolean; deferIfBusy?: boolean },
  ): Promise<HeartbeatRunTemplateResult>;
  runDeferredTemplate(
    templateId: string,
    options?: { sendToDiscordOverride?: boolean; actionId?: string },
  ): Promise<void>;
  syncReflectionTasks(): void;
}

interface CreateHeartbeatTemplateRuntimeOptions {
  scheduler: Scheduler;
  agentLoop: HeartbeatAgent;
  sender: MessageSender;
  dataDir: string;
  heartbeatChannelId?: string;
  runtimeOptions?: HeartbeatRuntimeOptions;
}

export function createHeartbeatTemplateRuntime(
  options: CreateHeartbeatTemplateRuntimeOptions,
): HeartbeatTemplateRuntime {
  const {
    scheduler,
    agentLoop,
    sender,
    dataDir,
    heartbeatChannelId,
    runtimeOptions = {},
  } = options;

  const store = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(dataDir));
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(dataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(dataDir)],
  });
  const reflectionJournal = new ReflectionJournalStore(resolveReflectionJournalPath(dataDir));
  const reflectionDailyJournal = new ReflectionDailyJournalStore(resolveReflectionDailyJournalsDir(dataDir));
  const reflectionProcessLog = new ReflectionProcessLogStore(resolveReflectionProcessLogsDir(dataDir));
  const initialPolicy = store.load();
  const pendingDeferredTemplates = new Set<string>();
  const lastScheduledRunAt = new Map<string, number>();
  const templateExecutionHistory = new Map<string, number[]>();
  const templateExecutionCooldownUntil = new Map<string, number>();

  const assertTemplateExecutionAllowed = (
    templateId: string,
    source: HeartbeatExecutionSource,
  ): void => {
    if (source === 'manual') {
      return;
    }

    const now = Date.now();
    const cooldownUntil = templateExecutionCooldownUntil.get(templateId);
    if (typeof cooldownUntil === 'number' && cooldownUntil > now) {
      throw new HeartbeatTemplateLoopGuardError(
        templateId,
        source,
        cooldownUntil,
        `Template "${templateId}" is temporarily suppressed by rapid-fire loop guard`,
      );
    }

    const recentRuns = (templateExecutionHistory.get(templateId) ?? [])
      .filter((timestamp) => now - timestamp <= TEMPLATE_EXECUTION_BURST_WINDOW_MS);
    recentRuns.push(now);
    templateExecutionHistory.set(templateId, recentRuns);

    if (recentRuns.length <= TEMPLATE_EXECUTION_BURST_LIMIT) {
      return;
    }

    const nextCooldownUntil = now + TEMPLATE_EXECUTION_COOLDOWN_MS;
    templateExecutionCooldownUntil.set(templateId, nextCooldownUntil);
    log.error('Suppressing reflection template due to rapid-fire loop guard', {
      templateId,
      source,
      burstCount: recentRuns.length,
      windowMs: TEMPLATE_EXECUTION_BURST_WINDOW_MS,
      cooldownUntil: new Date(nextCooldownUntil).toISOString(),
    });
    throw new HeartbeatTemplateLoopGuardError(
      templateId,
      source,
      nextCooldownUntil,
      `Template "${templateId}" exceeded rapid-fire burst limits`,
    );
  };

  let latestMetacognitiveFlags: ReflectionMetacognitiveFlag[] = [];

  const normalizeMetacognitiveFlags = (
    value: unknown,
    context: string,
  ): ReflectionMetacognitiveFlag[] => {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error(`${context} must be an array when provided`);
    }
    return value.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`${context}[${String(index)}] must be an object`);
      }
      const flagRaw = (entry as { flag?: unknown }).flag;
      if (typeof flagRaw !== 'string' || flagRaw.trim().length === 0) {
        throw new Error(`${context}[${String(index)}].flag must be a non-empty string`);
      }
      const confidenceRaw = (entry as { confidence?: unknown }).confidence;
      if (typeof confidenceRaw !== 'number' || !Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 1) {
        throw new Error(`${context}[${String(index)}].confidence must be a finite number in [0, 1]`);
      }
      const evidenceRaw = (entry as { evidence?: unknown }).evidence;
      if (evidenceRaw !== undefined && (typeof evidenceRaw !== 'string' || evidenceRaw.trim().length === 0)) {
        throw new Error(`${context}[${String(index)}].evidence must be a non-empty string when provided`);
      }
      return {
        flag: flagRaw.trim(),
        confidence: Number(confidenceRaw.toFixed(4)),
        ...(typeof evidenceRaw === 'string' ? { evidence: evidenceRaw.trim() } : {}),
      };
    });
  };

  const normalizeSnapshotRef = (value: unknown, fieldName: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${fieldName} must be a non-empty string when provided`);
    }
    return value.trim();
  };

  const resolveInternalStateContext = (
    template: ReflectionTemplate,
  ): ReflectionInternalStateContext | null => {
    if (!template.internalStateInput) {
      return null;
    }

    const currentInternalState = agentLoop.getCurrentInternalState?.();
    if (!currentInternalState) {
      throw new Error(`Template "${template.id}" requires InternalState input, but no InternalState snapshot is available`);
    }

    const normalizedState = cloneInternalState(currentInternalState);
    const snapshotRef = normalizeSnapshotRef(
      agentLoop.getCurrentInternalStateSnapshotRef?.(),
      'getCurrentInternalStateSnapshotRef result',
    ) ?? buildInternalStateSnapshotRef(normalizedState);
    const rawMetacognitiveFlags = agentLoop.getCurrentMetacognitiveFlags?.();
    const metacognitiveFlags = rawMetacognitiveFlags !== undefined
      ? normalizeMetacognitiveFlags(rawMetacognitiveFlags, 'getCurrentMetacognitiveFlags result')
      : latestMetacognitiveFlags;
    latestMetacognitiveFlags = metacognitiveFlags;

    return {
      internalState: normalizedState,
      internalStateSnapshotRef: snapshotRef,
      metacognitiveFlags,
    };
  };

  const formatNarrativePromptInput = (
    prompt: string,
    context: ReflectionInternalStateContext | null,
    substrateContext: ReflectionSubstratePromptContext | null,
    appearanceContext?: string,
  ): string => {
    const sections: string[] = [prompt];
    if (context) {
      const concerns = context.internalState.attention.activeConcerns
        .slice(0, 12)
        .map((concern) => `[${concern.priority}|${concern.source}] ${concern.text}`);
      const concernSection = concerns.length > 0
        ? concerns.map((concern) => `- ${concern}`).join('\n')
        : '- none';
      const metacognitiveSection = context.metacognitiveFlags.length > 0
        ? context.metacognitiveFlags
          .map((flag) => `- ${flag.flag} (confidence=${flag.confidence.toFixed(2)})${flag.evidence ? ` evidence: ${flag.evidence}` : ''}`)
          .join('\n')
        : '- none exposed';

      sections.push(
        [
          '[Internal State Input]',
          `snapshot_ref: ${context.internalStateSnapshotRef}`,
          `serialized_internal_state: ${serializeInternalState(context.internalState)}`,
          '[Recent Metacognitive Flags]',
          metacognitiveSection,
          '[Active Concerns]',
          concernSection,
        ].join('\n'),
      );
    }
    if (substrateContext) {
      sections.push(substrateContext.promptBlock);
    }
    if (appearanceContext) {
      sections.push(`Appearance context:\n${appearanceContext}`);
    }
    return sections.join('\n\n');
  };

  const resolveReflectionSubstratePromptContext = (
    template: ReflectionTemplate,
  ): ReflectionSubstratePromptContext | null => {
    if (!template.internalStateInput && template.mode !== 'deliberation') {
      return null;
    }
    const context = assembleReflectionSubstrateContext({
      recentReflectionJournalEntries: reflectionJournal.listRecent({ limit: 2 }),
      recentDailyJournalEntries: reflectionDailyJournal.listRecent({ limit: 2 }),
      recentProcessLogEntries: reflectionProcessLog.listRecent({
        limit: 2,
        stages: ['completed', 'failed'],
      }),
    });
    return context
      ? {
        canonicalTruthBoundary: context.canonicalTruthBoundary,
        promptBlock: context.promptBlock,
        provenanceRefs: context.provenanceRefs,
      }
      : null;
  };

  const captureResponseInternalStateContext = (
    response: Awaited<ReturnType<HeartbeatAgent['handleMessage']>>,
  ): ReflectionInternalStateContext | null => {
    const metadata = response.metadata;
    if (!metadata) {
      return null;
    }

    if (metadata.internalState === undefined && metadata.internalStateSnapshotRef === undefined && metadata.metacognitiveFlags === undefined) {
      return null;
    }

    if (metadata.internalState === undefined) {
      throw new Error('Heartbeat response metadata.internalState is required when snapshot metadata is provided');
    }

    const internalState = cloneInternalState(metadata.internalState);
    const snapshotRef = normalizeSnapshotRef(
      metadata.internalStateSnapshotRef,
      'metadata.internalStateSnapshotRef',
    ) ?? buildInternalStateSnapshotRef(internalState);
    const metacognitiveFlags = normalizeMetacognitiveFlags(
      metadata.metacognitiveFlags,
      'metadata.metacognitiveFlags',
    );
    latestMetacognitiveFlags = metacognitiveFlags;
    return {
      internalState,
      internalStateSnapshotRef: snapshotRef,
      metacognitiveFlags,
    };
  };

  const toDeliberationMetadata = (
    result: DeliberationResult,
  ): ValuesDeliberationMetadata => ({
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    rounds: result.rounds.length,
    totalInputTokens: result.totalInputTokens,
    totalOutputTokens: result.totalOutputTokens,
    totalTokens: result.totalTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    durationMs: result.durationMs,
  });

  const persistDeliberationMemory = async (
    template: ReflectionTemplate,
    reflection: string,
    metadata: ValuesDeliberationMetadata,
  ): Promise<void> => {
    if (!runtimeOptions.memoryWriter) return;
    await runtimeOptions.memoryWriter.write({
      text: reflection,
      type: 'reflection',
      importance: 0.72,
      confidence: 0.78,
      emotionalValence: 0,
      sourceRef:
        `source:heartbeat|template:${template.id}|mode:deliberation`
        + `|session:${metadata.sessionId}|tokens:${metadata.totalTokens}`
        + `|cost_usd:${metadata.estimatedCostUsd.toFixed(6)}`,
      tags: [
        'heartbeat',
        'reflection',
        'deliberation',
        template.id,
        `stop:${metadata.stopReason}`,
      ],
    });
  };

  const shouldUseDeliberation = (template: ReflectionTemplate): boolean => {
    if (template.mode !== 'deliberation') return false;
    return Boolean(runtimeOptions.llmProvider);
  };

  const normalizeTemplateReflectionOutput = (
    template: ReflectionTemplate,
    reflection: string,
  ): { reflection: string; silent: boolean } => {
    const trimmed = reflection.trim();
    const audit = getHeartbeatTemplateAuditProfile(template);
    if (
      audit.allowSilentInterval
      && (
        trimmed.length === 0
        || trimmed.toLowerCase() === HEARTBEAT_SILENT_REFLECTION_TOKEN
      )
    ) {
      return { reflection: '', silent: true };
    }
    return { reflection: trimmed, silent: false };
  };

  const resolveDeliberationAppearanceContext = (): string | undefined => {
    const provider = runtimeOptions.characterPromptVariablesProvider;
    if (!provider) return undefined;
    try {
      const variables = provider();
      const candidates = [
        variables['character.visual_description'],
        variables.visual_description,
        variables.extensions_visual_description,
      ];
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    } catch (error) {
      log.warn('Failed to resolve appearance context for deliberation heartbeat', {
        error: String(error),
      });
    }
    return undefined;
  };

  const runTemplateDeliberation = async (
    template: ReflectionTemplate,
    prompt: string,
  ): Promise<{ reflection: string; metadata: ValuesDeliberationMetadata }> => {
    const llmProvider = runtimeOptions.llmProvider;
    if (!llmProvider) {
      throw new Error('Deliberation mode requested without llmProvider');
    }
    const result = await runDeliberation(
      llmProvider,
      prompt,
      {
        ...(template.deliberation?.voices ? { voices: template.deliberation.voices } : {}),
        caps: {
          ...(template.deliberation?.maxRounds !== undefined
            ? { maxRounds: template.deliberation.maxRounds }
            : {}),
          ...(template.deliberation?.maxTotalTokens !== undefined
            ? { maxTotalTokens: template.deliberation.maxTotalTokens }
            : {}),
          ...(template.deliberation?.maxWallTimeMs !== undefined
            ? { maxWallTimeMs: template.deliberation.maxWallTimeMs }
            : {}),
        },
        cost: {
          ...(template.deliberation?.inputUsdPerMillionTokens !== undefined
            ? { inputUsdPerMillionTokens: template.deliberation.inputUsdPerMillionTokens }
            : {}),
          ...(template.deliberation?.outputUsdPerMillionTokens !== undefined
            ? { outputUsdPerMillionTokens: template.deliberation.outputUsdPerMillionTokens }
            : {}),
        },
      },
    );
    return {
      reflection: result.output,
      metadata: toDeliberationMetadata(result),
    };
  };

  const executeTemplate = async (
    template: ReflectionTemplate,
    options: { sendToDiscordOverride?: boolean } = {},
    source: HeartbeatExecutionSource = 'scheduled',
  ): Promise<Omit<HeartbeatRunTemplateResult, 'queued' | 'deferredAction'>> => {
    assertTemplateExecutionAllowed(template.id, source);

    const reflectionChannelId = `internal:reflection:${template.id}`;
    const internalStateContext = resolveInternalStateContext(template);
    const reflectionSubstrateContext = resolveReflectionSubstratePromptContext(template);
    const appearanceContext = shouldUseDeliberation(template) ? resolveDeliberationAppearanceContext() : undefined;
    const reflectionCreatedAt = new Date(Date.now()).toISOString();
    const reflectionPrompt = formatNarrativePromptInput(
      template.prompt,
      internalStateContext,
      reflectionSubstrateContext,
      appearanceContext,
    );
    let reflectionText = '';
    let silentInterval = false;
    let deliberationMetadata: ValuesDeliberationMetadata | undefined;
    let reflectionMode: 'agent' | 'deliberation' = 'agent';
    let persistenceContext = internalStateContext;
    let reflectionProcessId: string | undefined;

    if (shouldUseDeliberation(template)) {
      const processId = buildReflectionProcessId(`${template.id}-${source}`);
      reflectionProcessId = processId;
      try {
        reflectionProcessLog.append({
          processId,
          processLabel: `${template.name} deliberation`,
          processType: 'reflection_deliberation',
          stage: 'started',
          executionSource: source,
          createdAt: reflectionCreatedAt,
          templateId: template.id,
          templateName: template.name,
          channelId: reflectionChannelId,
          prompt: reflectionPrompt,
          tags: [template.id, 'reflection', 'deliberation'],
        });
      } catch (error) {
        log.warn(`Reflection "${template.id}" process-start log persistence skipped`, {
          error: String(error),
        });
      }

      try {
        const deliberationResult = await runTemplateDeliberation(template, reflectionPrompt);
        const normalizedReflection = normalizeTemplateReflectionOutput(template, deliberationResult.reflection);
        reflectionText = normalizedReflection.reflection;
        silentInterval = normalizedReflection.silent;
        deliberationMetadata = deliberationResult.metadata;
        reflectionMode = 'deliberation';

        try {
          reflectionProcessLog.append({
            processId,
            processLabel: `${template.name} deliberation`,
            processType: 'reflection_deliberation',
            stage: 'completed',
            executionSource: source,
            createdAt: new Date(Date.now()).toISOString(),
            templateId: template.id,
            templateName: template.name,
            channelId: reflectionChannelId,
            prompt: reflectionPrompt,
            ...(reflectionText ? { reflection: reflectionText } : {}),
            deliberation: deliberationMetadata,
            tags: [template.id, 'reflection', 'deliberation'],
          });
        } catch (error) {
          log.warn(`Reflection "${template.id}" process log persistence skipped`, {
            error: String(error),
          });
        }

        if (!silentInterval) {
          try {
            await persistDeliberationMemory(template, reflectionText, deliberationMetadata);
          } catch (error) {
            log.warn(`Reflection "${template.id}" memory persistence skipped`, {
              error: String(error),
            });
          }
        }
      } catch (error) {
        try {
          reflectionProcessLog.append({
            processId,
            processLabel: `${template.name} deliberation`,
            processType: 'reflection_deliberation',
            stage: 'failed',
            executionSource: source,
            createdAt: new Date(Date.now()).toISOString(),
            templateId: template.id,
            templateName: template.name,
            channelId: reflectionChannelId,
            prompt: reflectionPrompt,
            error: String(error),
            tags: [template.id, 'reflection', 'deliberation'],
          });
        } catch (processLogError) {
          log.warn(`Reflection "${template.id}" process-failure log persistence skipped`, {
            error: String(processLogError),
          });
        }
        throw error;
      }
    } else {
      const response = await agentLoop.handleMessage({
        id: `reflection-${template.id}-${Date.now()}`,
        channelId: reflectionChannelId,
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: template.name,
        content: reflectionPrompt,
        timestamp: new Date(),
        routing: {
          workerExecution: createWorkerExecutionPolicy(WHISPER_WORKER_LANE),
        },
      });
      const normalizedReflection = normalizeTemplateReflectionOutput(template, response.content);
      reflectionText = normalizedReflection.reflection;
      silentInterval = normalizedReflection.silent;
      const responseContext = captureResponseInternalStateContext(response);
      if (responseContext) {
        persistenceContext = responseContext;
      }
    }

    let reflectionJournalEntryId: string | undefined;
    if (!silentInterval) {
      try {
        const reflectionEntry = reflectionJournal.append({
          templateId: template.id,
          templateName: template.name,
          prompt: reflectionPrompt,
          reflection: reflectionText,
          channelId: reflectionChannelId,
          mode: reflectionMode,
          createdAt: reflectionCreatedAt,
          ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
          ...(persistenceContext ? {
            internalStateSnapshotRef: persistenceContext.internalStateSnapshotRef,
            internalState: persistenceContext.internalState,
            metacognitiveFlags: persistenceContext.metacognitiveFlags,
          } : {}),
          ...(reflectionSubstrateContext ? {
            substrateBoundary: reflectionSubstrateContext.canonicalTruthBoundary,
            substrateProvenanceRefs: reflectionSubstrateContext.provenanceRefs,
          } : {}),
        });
        reflectionJournalEntryId = reflectionEntry.id;
      } catch (error) {
        log.warn(`Reflection "${template.id}" note journal persistence skipped`, {
          error: String(error),
        });
      }

      try {
        reflectionDailyJournal.append({
          source: 'heartbeat_template',
          executionSource: source,
          templateId: template.id,
          templateName: template.name,
          channelId: reflectionChannelId,
          prompt: reflectionPrompt,
          reflection: reflectionText,
          mode: reflectionMode,
          createdAt: reflectionCreatedAt,
          ...(reflectionJournalEntryId ? { reflectionJournalEntryId } : {}),
          ...(reflectionProcessId ? { processId: reflectionProcessId } : {}),
          tags: [template.id, 'reflection', reflectionMode],
        });
      } catch (error) {
        log.warn(`Reflection "${template.id}" daily journal persistence skipped`, {
          error: String(error),
        });
      }

      if (template.id === 'values-reflection') {
        valuesJournal.append({
          templateId: template.id,
          templateName: template.name,
          prompt: reflectionPrompt,
          reflection: reflectionText,
          ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
          ...(persistenceContext ? {
            internalStateSnapshotRef: persistenceContext.internalStateSnapshotRef,
            internalState: persistenceContext.internalState,
            metacognitiveFlags: persistenceContext.metacognitiveFlags,
          } : {}),
          provenance: {
            source: 'companion_reflection',
            templateId: template.id,
            templateName: template.name,
            channelId: reflectionChannelId,
            mode: reflectionMode,
            ...(reflectionJournalEntryId ? { reflectionJournalEntryId } : {}),
          },
        });
      }

      if (runtimeOptions.vaultAutoPublisher) {
        try {
          await runtimeOptions.vaultAutoPublisher.publishReflection({
            templateId: template.id,
            templateName: template.name,
            reflection: reflectionText,
            mode: reflectionMode,
            createdAt: new Date(),
          });
        } catch (error) {
          log.warn(`Reflection "${template.id}" vault publish skipped`, { error: String(error) });
        }
      }
    }

    const shouldSendToDiscord = options.sendToDiscordOverride ?? template.sendToDiscord;
    if (!silentInterval && shouldSendToDiscord && heartbeatChannelId) {
      await sender.send(heartbeatChannelId, reflectionText);
    }

    return {
      templateId: template.id,
      templateName: template.name,
      reflection: reflectionText,
      ...(silentInterval ? { silent: true } : {}),
    };
  };

  const executeScheduledTemplate = async (template: ReflectionTemplate): Promise<void> => {
    const now = Date.now();
    const lastRunAt = lastScheduledRunAt.get(template.id);
    if (lastRunAt !== undefined && now - lastRunAt < MIN_SCHEDULED_TEMPLATE_GAP_MS) {
      log.warn(`Skipping reflection "${template.id}" due to rapid re-fire guard`, {
        templateId: template.id,
        sinceLastMs: now - lastRunAt,
      });
      return;
    }
    lastScheduledRunAt.set(template.id, now);
    try {
      await executeTemplate(template, {}, 'scheduled');
    } catch (error) {
      if (isHeartbeatTemplateLoopGuardError(error)) {
        log.warn('Scheduled reflection suppressed by rapid-fire loop guard', {
          templateId: template.id,
          source: error.source,
          cooldownUntil: new Date(error.cooldownUntil).toISOString(),
        });
        return;
      }
      if (!isBusyTurnError(error)) {
        throw error;
      }
      const deferred = queueDeferredTemplateRun(template.id);
      log.info('Deferred scheduled reflection template execution', {
        templateId: template.id,
        queuedNow: deferred.queuedNow,
      });
    }
  };

  const buildDeferredHeartbeatAction = (
    template: ReflectionTemplate,
    options: { sendToDiscordOverride?: boolean } = {},
  ): PostTurnActionCandidate => ({
    kind: DEFERRED_HEARTBEAT_ACTION_KIND,
    payload: {
      templateId: template.id,
      ...(options.sendToDiscordOverride !== undefined
        ? { sendToDiscordOverride: options.sendToDiscordOverride }
        : {}),
    },
    dedupeKey: (
      options.sendToDiscordOverride === undefined
        ? `${DEFERRED_HEARTBEAT_ACTION_KIND}:${template.id}`
        : `${DEFERRED_HEARTBEAT_ACTION_KIND}:${template.id}:discord:${String(options.sendToDiscordOverride)}`
    ),
    maxRetries: 2,
  });

  const queueDeferredTemplateRun = (
    templateId: string,
    options: { sendToDiscordOverride?: boolean } = {},
  ): { templateName: string; queuedNow: boolean } => {
    const current = store.load();
    const template = current.templates.find(candidate => candidate.id === templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    if (pendingDeferredTemplates.has(template.id)) {
      return { templateName: template.name, queuedNow: false };
    }

    pendingDeferredTemplates.add(template.id);
    const taskId = `${DEFERRED_REFLECTION_TASK_PREFIX}${template.id}:${Date.now()}`;
    try {
      scheduler.register({
        id: taskId,
        name: `${template.name} (deferred)`,
        type: 'one-shot',
        intervalMs: 0,
        runAt: Date.now() + 250,
        handler: async () => {
          try {
            await agentLoop.waitForIdle?.();
            const latestPolicy = store.load();
            const latestTemplate = latestPolicy.templates.find(candidate => candidate.id === template.id);
            if (!latestTemplate) {
              log.warn('Skipped deferred reflection; template removed before execution', {
                templateId: template.id,
                taskId,
              });
              return;
            }
            await executeTemplate(latestTemplate, options, 'deferred_scheduler');
          } catch (error) {
            if (isHeartbeatTemplateLoopGuardError(error)) {
              log.warn(`Deferred reflection "${template.id}" suppressed by rapid-fire loop guard`, {
                templateId: template.id,
                source: error.source,
                cooldownUntil: new Date(error.cooldownUntil).toISOString(),
              });
              return;
            }
            log.error(`Deferred reflection "${template.id}" failed`, { error: String(error) });
          } finally {
            pendingDeferredTemplates.delete(template.id);
          }
        },
        state: 'idle',
      });
      return { templateName: template.name, queuedNow: true };
    } catch (error) {
      pendingDeferredTemplates.delete(template.id);
      throw error;
    }
  };

  const runTemplateNow = async (
    templateId: string,
    options: { sendToDiscordOverride?: boolean; deferIfBusy?: boolean } = {},
  ): Promise<HeartbeatRunTemplateResult> => {
    const current = store.load();
    const template = current.templates.find(candidate => candidate.id === templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    try {
      return await executeTemplate(template, options, 'manual');
    } catch (error) {
      if (options.deferIfBusy === false || !isBusyTurnError(error)) {
        throw error;
      }
      if (runtimeOptions.postTurnActions) {
        const deferredAction = buildDeferredHeartbeatAction(template, options);
        log.info('Inferred deferred heartbeat action from busy template execution', {
          templateId: template.id,
          dedupeKey: deferredAction.dedupeKey,
        });
        return {
          templateId: template.id,
          templateName: template.name,
          reflection: '',
          queued: true,
          deferredAction,
        };
      }

      const deferred = queueDeferredTemplateRun(template.id, {
        sendToDiscordOverride: options.sendToDiscordOverride,
      });
      log.info('Deferred manual reflection template execution', {
        templateId: template.id,
        queuedNow: deferred.queuedNow,
      });
      return {
        templateId: template.id,
        templateName: deferred.templateName,
        reflection: '',
        queued: true,
        deferredAction: buildDeferredHeartbeatAction(template, options),
      };
    }
  };

  const runDeferredTemplate = async (
    templateId: string,
    options: { sendToDiscordOverride?: boolean; actionId?: string } = {},
  ): Promise<void> => {
    const current = store.load();
    const template = current.templates.find(candidate => candidate.id === templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    try {
      await executeTemplate(template, {
        ...(options.sendToDiscordOverride !== undefined
          ? { sendToDiscordOverride: options.sendToDiscordOverride }
          : {}),
      }, 'deferred_post_turn');
    } catch (error) {
      if (isHeartbeatTemplateLoopGuardError(error)) {
        log.warn(`Deferred heartbeat action "${options.actionId ?? templateId}" suppressed by rapid-fire loop guard`, {
          templateId,
          source: error.source,
          cooldownUntil: new Date(error.cooldownUntil).toISOString(),
        });
        return;
      }
      throw error;
    }
  };

  const syncReflectionTasks = (): void => {
    for (const task of scheduler.listTasks()) {
      if (task.id.startsWith('reflection:') && !task.id.startsWith(DEFERRED_REFLECTION_TASK_PREFIX)) {
        scheduler.unregister(task.id);
      }
    }

    const current = store.load();
    for (const template of current.templates) {
      if (!template.enabled) continue;
      scheduler.register(
        {
          id: `reflection:${template.id}`,
          name: template.name,
          type: 'every',
          intervalMs: template.intervalMs,
          cadence: template.cadence,
          handler: async () => {
            try {
              await executeScheduledTemplate(template);
            } catch (err) {
              log.error(`Reflection "${template.id}" error`, { error: String(err) });
            }
          },
          state: 'idle',
        },
        { skipFirstRun: true },
      );
    }

    const activeCount = current.templates.filter(t => t.enabled).length;
    log.info(`Synced ${activeCount} reflection tasks`);
  };

  syncReflectionTasks();

  return {
    policyStore: store,
    valuesJournal,
    initialPolicy,
    runTemplateNow,
    runDeferredTemplate,
    syncReflectionTasks,
  };
}

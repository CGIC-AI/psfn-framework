import { createHash } from 'node:crypto';
import type { AdaptiveToolSnapshotTelemetry } from '../agent/adaptive-tools-telemetry.js';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import type { MemoryWithheldSummary } from '../../faculties/memory/withheld-summary.js';
import type { ContactProfileArtifact } from '../../faculties/memory/memory-store-port.js';
import type {
  PurrMemory,
  RetrievalCallerContext,
  RetrievalModeInput,
} from '../../faculties/memory/types.js';
import type { EpisodicRetrievalChain } from '../../faculties/memory/retrieval/episodic.js';
import type { SessionEntry } from '../session/types.js';
import type { SessionContinuityArtifact } from '../session/continuity-artifacts.js';
import type { IdleGapTexture } from '../scheduler/time-texture.js';
import type {
  ContextMessage,
  FatigueEnforcementMetadata,
  LLMProviderObservability,
  PromptSectionTelemetry,
  ToolSchema,
  TurnID,
} from '../../shared/contracts/runtime.js';
import { cloneAuthenticityProvenance } from '../../shared/authenticity-provenance.js';
import type { TrustLevel } from '../../system/trust/types.js';

export type { FatigueEnforcementMetadata };

export type PromptCacheabilityClass = 'static' | 'session_stable' | 'append_only' | 'volatile';
export type PromptCacheBreaker =
  | 'prompt_layer'
  | 'runtime'
  | 'channel'
  | 'task'
  | 'macro'
  | 'tool'
  | 'retrieval'
  | 'scratchpad'
  | 'session_history';

export interface PromptSectionCacheability {
  section:
    | 'staticPrefixTemplate'
    | 'dynamicSuffixTemplate'
    | 'renderedStaticPrefix'
    | 'renderedDynamicSuffix'
    | 'runtimeContext'
    | 'memoryContextBlock'
    | 'scratchpadContext'
    | 'assembledPrompt'
    | 'finalSystemPrompt'
    | 'messages';
  cacheability: PromptCacheabilityClass;
  cacheBreakers: PromptCacheBreaker[];
  reason: string;
}

export interface TurnPromptSnapshot {
  staticPrefixTemplate: string;
  dynamicSuffixTemplate: string;
  staticHash: string;
  versionPointer: string;
  sectionCacheability?: PromptSectionCacheability[];
}

export interface TurnSessionContextSnapshot {
  channelId: string;
  recentEntries: SessionEntry[];
  historySummaryText?: string;
  historySummaryEntryCount?: number;
  compactionSummaryTexts: string[];
  focusKnowledgeTexts: string[];
  continuityEntries: SessionEntry[];
  wakeReturnArtifacts?: SessionContinuityArtifact[];
  orientation?: TurnOrientationSnapshot;
  intentionAppraisalArtifactCount?: number;
  compactionPromptText?: string;
  versionPointer: string;
}

export interface TurnOrientationSnapshot {
  fired: boolean;
  reason: 'idle_gap_exceeded' | 'below_threshold' | 'no_previous_activity' | 'internal_channel';
  observedAt: number;
  idleThresholdMs: number;
  lastActivityAt?: number;
  idleGapMs?: number;
  noteText?: string;
  sessionSummary?: string;
  continuitySummary?: string;
  lastUserMessage?: string;
  openThreadSummary?: string;
  timeTexture?: IdleGapTexture;
  sourceCounts: {
    session: number;
    continuity: number;
    focusKnowledge: number;
  };
}

export interface TurnMemorySnapshot {
  channelId: string;
  profile?: ContactProfileArtifact;
  emotionalSnapshot?: EmotionalSnapshot;
  contactEmotionalMemories: PurrMemory[];
  semanticCandidates: Array<PurrMemory & { similarity: number }>;
  lexicalCandidates: Array<PurrMemory & { similarity: number }>;
  episodicChains?: EpisodicRetrievalChain[];
  proactiveCandidates: PurrMemory[];
  withheldSummary?: MemoryWithheldSummary;
  withheldCandidateIds?: string[];
  callerContext?: RetrievalCallerContext;
  retrievalMode?: RetrievalModeInput;
  versionPointer: string;
}

export interface TurnPromptResponseSnapshot {
  content: string;
  reasoning?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallCount?: number;
}

export interface TurnPromptContextSnapshot {
  renderedStaticPrefix: string;
  renderedDynamicSuffix: string;
  runtimeContext: string;
  memoryContextBlock: string;
  scratchpadContext: string;
  assembledPrompt: string;
  finalSystemPrompt: string;
  messages: ContextMessage[];
  currentTurnInput?: string;
  providerObservability?: LLMProviderObservability;
  response?: TurnPromptResponseSnapshot;
  inputSections?: PromptSectionTelemetry[];
  runtimeContextSections?: PromptSectionTelemetry[];
  memoryContextSections?: PromptSectionTelemetry[];
  finalSystemSections?: PromptSectionTelemetry[];
  sectionCacheability?: PromptSectionCacheability[];
}

export interface TurnToolContextSnapshot {
  activeTools: ToolSchema[];
  adaptiveSnapshot?: AdaptiveToolSnapshotTelemetry;
}

export interface TurnSnapshot {
  turnId: TurnID;
  requestId: string;
  channelId: string;
  capturedAt: number;
  trustLevel: TrustLevel;
  canonicalContactKey?: string;
  prompt?: TurnPromptSnapshot;
  promptContext?: TurnPromptContextSnapshot;
  toolContext?: TurnToolContextSnapshot;
  sessionContext?: TurnSessionContextSnapshot;
  memory?: TurnMemorySnapshot;
  fatigue?: FatigueEnforcementMetadata;
}

export function buildSnapshotVersionPointer(parts: ReadonlyArray<string | number | null | undefined>): string {
  const payload = parts
    .map((part) => {
      if (part === null || part === undefined) return '';
      return typeof part === 'number' ? String(Math.trunc(part)) : part;
    })
    .join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return { ...entry };
}

export function cloneSessionContinuityArtifact(
  artifact: SessionContinuityArtifact,
): SessionContinuityArtifact {
  return {
    ...artifact,
    facets: [...artifact.facets],
  };
}

export function cloneOrientationSnapshot(snapshot: TurnOrientationSnapshot): TurnOrientationSnapshot {
  return {
    ...snapshot,
    sourceCounts: { ...snapshot.sourceCounts },
  };
}

export function cloneContactProfileArtifact(profile: ContactProfileArtifact): ContactProfileArtifact {
  return {
    ...profile,
    sourceMemoryIds: [...profile.sourceMemoryIds],
  };
}

export function cloneEmotionalSnapshot(snapshot: EmotionalSnapshot): EmotionalSnapshot {
  return { ...snapshot };
}

export function cloneContextMessage(message: ContextMessage): ContextMessage {
  return {
    ...message,
    ...(message.provenance ? { provenance: cloneAuthenticityProvenance(message.provenance) } : {}),
  };
}

export function cloneProviderObservability(
  observability: LLMProviderObservability,
): LLMProviderObservability {
  return {
    ...observability,
    systemRole: { ...observability.systemRole },
    providerWireMessages: observability.providerWireMessages.map(message => ({ ...message })),
  };
}

export function cloneTurnPromptResponseSnapshot(
  response: TurnPromptResponseSnapshot,
): TurnPromptResponseSnapshot {
  return {
    ...response,
  };
}

export function clonePromptSectionCacheability(
  section: PromptSectionCacheability,
): PromptSectionCacheability {
  return {
    ...section,
    cacheBreakers: [...section.cacheBreakers],
  };
}

export function clonePromptSectionTelemetry(section: PromptSectionTelemetry): PromptSectionTelemetry {
  return {
    ...section,
    ...(section.provenance ? { provenance: cloneAuthenticityProvenance(section.provenance) } : {}),
    ...(section.scopeProvenance ? { scopeProvenance: { ...section.scopeProvenance } } : {}),
  };
}

function cloneUnknownSchemaValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cloneUnknownSchemaValue(item)) as T;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const cloned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    cloned[key] = cloneUnknownSchemaValue(item);
  }
  return cloned as T;
}

export function cloneToolSchema(tool: ToolSchema): ToolSchema {
  return {
    ...tool,
    inputSchema: cloneUnknownSchemaValue(tool.inputSchema),
  };
}

export function cloneAdaptiveToolSnapshotTelemetry(
  snapshot: AdaptiveToolSnapshotTelemetry | null | undefined,
): AdaptiveToolSnapshotTelemetry | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    tools: snapshot.tools.map(tool => ({ ...tool })),
    skipped: snapshot.skipped.map(skip => ({
      ...skip,
      ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
    })),
    counts: { ...snapshot.counts },
  };
}

export function cloneMemory<T extends PurrMemory>(memory: T): T {
  return {
    ...memory,
    tags: [...memory.tags],
    ...(memory.scopeRef ? { scopeRef: { ...memory.scopeRef } } : {}),
    ...(memory.scopeTags ? { scopeTags: [...memory.scopeTags] } : {}),
    ...(memory.provenanceRefs ? { provenanceRefs: [...memory.provenanceRefs] } : {}),
    ...(memory.consentFlags ? { consentFlags: { ...memory.consentFlags } } : {}),
    ...(memory.embedding ? { embedding: new Float32Array(memory.embedding) } : {}),
  };
}

export function cloneScoredMemory(
  memory: PurrMemory & { similarity: number },
): PurrMemory & { similarity: number } {
  return {
    ...cloneMemory(memory),
    similarity: memory.similarity,
  };
}

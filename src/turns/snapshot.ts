import { createHash } from 'node:crypto';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import type { MemoryWithheldSummary } from '../memory/withheld-summary.js';
import type { ContactProfileArtifact } from '../memory/store.js';
import type { PurrMemory } from '../memory/types.js';
import type { SessionEntry } from '../session/types.js';
import type { ContextMessage, TurnID } from '../types.js';
import type { TrustLevel } from '../trust/types.js';

export interface TurnPromptSnapshot {
  staticPrefixTemplate: string;
  dynamicSuffixTemplate: string;
  staticHash: string;
  versionPointer: string;
}

export interface TurnSessionContextSnapshot {
  channelId: string;
  recentEntries: SessionEntry[];
  compactionSummaryTexts: string[];
  focusKnowledgeTexts: string[];
  continuityEntries: SessionEntry[];
  compactionPromptText?: string;
  versionPointer: string;
}

export interface TurnMemorySnapshot {
  channelId: string;
  profile?: ContactProfileArtifact;
  emotionalSnapshot?: EmotionalSnapshot;
  contactEmotionalMemories: PurrMemory[];
  semanticCandidates: Array<PurrMemory & { similarity: number }>;
  lexicalCandidates: Array<PurrMemory & { similarity: number }>;
  proactiveCandidates: PurrMemory[];
  withheldSummary?: MemoryWithheldSummary;
  withheldCandidateIds?: string[];
  versionPointer: string;
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
  sessionContext?: TurnSessionContextSnapshot;
  memory?: TurnMemorySnapshot;
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
  return { ...message };
}

export function cloneMemory<T extends PurrMemory>(memory: T): T {
  return {
    ...memory,
    tags: [...memory.tags],
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

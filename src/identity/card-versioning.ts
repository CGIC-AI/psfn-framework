import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { CapabilityTier } from '../types.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { withCapabilityRequirement } from '../capabilities/requirements.js';
import type {
  ConfirmationQueue,
  ConfirmationQueueEntry,
} from '../capabilities/confirmation-queue.js';
import type { CharacterCardV2, CharacterData } from './types.js';
import { assertValidCharacterCard, loadCharacterCard } from './loader.js';
import { appendJsonLine } from '../persistence/jsonl.js';
import { writeJsonAtomic } from '../utils/fs.js';
import { toErrorMessage } from '../utils/errors.js';

const MUTABLE_CARD_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'tags',
  'creator',
  'creator_notes',
  'alternate_greetings',
  'extensions_visual_description',
] as const;

type MutableCardField = (typeof MUTABLE_CARD_FIELDS)[number];

export interface CharacterCardPatch {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  tags?: string[];
  creator?: string;
  creator_notes?: string;
  alternate_greetings?: string[];
  extensions_visual_description?: string;
}

const DESTRUCTIVE_REPLACE_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
] as const;

type DestructiveReplaceField = (typeof DESTRUCTIVE_REPLACE_FIELDS)[number];

interface DestructivePatchRisk {
  field: DestructiveReplaceField;
  previousLength: number;
  nextLength: number;
}

const MIN_DESTRUCTIVE_REPLACE_SOURCE_LENGTH = 400;
const MIN_DESTRUCTIVE_REPLACE_REMOVED_CHARS = 200;
const MAX_SAFE_REMAINING_RATIO = 0.6;

const PROTECTED_AUTONOMOUS_UPDATE_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
  'alternate_greetings',
  'extensions_visual_description',
] as const;

type ProtectedAutonomousUpdateField = (typeof PROTECTED_AUTONOMOUS_UPDATE_FIELDS)[number];

export interface CharacterCardHistoryEntry {
  version: number;
  timestamp: string;
  updatedBy: string;
  reason?: string;
  previousChecksum: string;
  newChecksum: string;
  previousCard: CharacterCardV2;
  newCard: CharacterCardV2;
}

export interface CharacterCardSnapshot {
  version: number;
  checksum: string;
  updatedAt: string;
  updatedBy: string;
  card: CharacterCardV2;
}

function cloneCard(card: CharacterCardV2): CharacterCardV2 {
  return JSON.parse(JSON.stringify(card)) as CharacterCardV2;
}

function cardChecksum(card: CharacterCardV2): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex').slice(0, 16);
}

function safeReadHistory(path: string): CharacterCardHistoryEntry[] {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CharacterCardHistoryEntry);
  } catch {
    return [];
  }
}

function hasPatchFields(patch: CharacterCardPatch): boolean {
  return MUTABLE_CARD_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(patch, field));
}

function sanitizeStringPatchValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value;
}

function sanitizeTagsPatchValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function sanitizeAlternateGreetingsPatchValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value !== 'string') return undefined;
  const parsed = value
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed;
}

function applyPatchToCharacterData(currentData: CharacterData, patch: CharacterCardPatch): CharacterData {
  return {
    ...currentData,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.personality !== undefined ? { personality: patch.personality } : {}),
    ...(patch.scenario !== undefined ? { scenario: patch.scenario } : {}),
    ...(patch.first_mes !== undefined ? { first_mes: patch.first_mes } : {}),
    ...(patch.mes_example !== undefined ? { mes_example: patch.mes_example } : {}),
    ...(patch.system_prompt !== undefined ? { system_prompt: patch.system_prompt } : {}),
    ...(patch.post_history_instructions !== undefined
      ? { post_history_instructions: patch.post_history_instructions }
      : {}),
    ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
    ...(patch.creator !== undefined ? { creator: patch.creator } : {}),
    ...(patch.creator_notes !== undefined ? { creator_notes: patch.creator_notes } : {}),
    ...(patch.alternate_greetings !== undefined
      ? { alternate_greetings: [...patch.alternate_greetings] }
      : {}),
    ...(patch.extensions_visual_description !== undefined
      ? {
        extensions: {
          ...(
            typeof currentData.extensions === 'object'
              ? currentData.extensions
              : {}
          ),
          visual_description: patch.extensions_visual_description,
        },
      }
      : {}),
  };
}

function trimmedTextLength(value: unknown): number {
  return typeof value === 'string' ? value.trim().length : 0;
}

function detectDestructivePatchRisks(
  currentData: CharacterData,
  patch: CharacterCardPatch,
): DestructivePatchRisk[] {
  const nextData = applyPatchToCharacterData(currentData, patch);
  const currentRecord = currentData as Record<string, unknown>;
  const nextRecord = nextData as Record<string, unknown>;
  const patchRecord = patch as Record<string, unknown>;

  return DESTRUCTIVE_REPLACE_FIELDS.flatMap((field) => {
    if (!Object.prototype.hasOwnProperty.call(patchRecord, field)) {
      return [];
    }

    const previousLength = trimmedTextLength(currentRecord[field]);
    const nextLength = trimmedTextLength(nextRecord[field]);
    const removedChars = previousLength - nextLength;
    const remainingRatio = previousLength > 0 ? nextLength / previousLength : 1;

    if (
      previousLength >= MIN_DESTRUCTIVE_REPLACE_SOURCE_LENGTH
      && removedChars >= MIN_DESTRUCTIVE_REPLACE_REMOVED_CHARS
      && remainingRatio <= MAX_SAFE_REMAINING_RATIO
    ) {
      return [{ field, previousLength, nextLength }];
    }

    return [];
  });
}

function formatDestructivePatchRisks(risks: DestructivePatchRisk[]): string {
  return risks
    .map((risk) => `${risk.field} ${risk.previousLength}->${risk.nextLength} chars`)
    .join(', ');
}

function resolveProtectedAutonomousUpdateFields(
  patch: CharacterCardPatch,
): ProtectedAutonomousUpdateField[] {
  const patchRecord = patch as Record<string, unknown>;
  return PROTECTED_AUTONOMOUS_UPDATE_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(patchRecord, field)
  );
}

function formatProtectedAutonomousUpdateFields(fields: ProtectedAutonomousUpdateField[]): string {
  return fields.join(', ');
}

export function extractCardPatchFromRecord(record: Record<string, unknown>): CharacterCardPatch {
  const patch: CharacterCardPatch = {};

  for (const field of MUTABLE_CARD_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;

    if (field === 'tags') {
      const tags = sanitizeTagsPatchValue(value);
      if (tags !== undefined) patch.tags = tags;
      continue;
    }

    if (field === 'alternate_greetings') {
      const greetings = sanitizeAlternateGreetingsPatchValue(value);
      if (greetings !== undefined) patch.alternate_greetings = greetings;
      continue;
    }

    const text = sanitizeStringPatchValue(value);
    if (text !== undefined) {
      (patch as Record<MutableCardField, unknown>)[field] = text;
    }
  }

  if (record['extensions.visual_description'] !== undefined) {
    const value = sanitizeStringPatchValue(record['extensions.visual_description']);
    if (value !== undefined) {
      patch.extensions_visual_description = value;
    }
  }

  return patch;
}

export class CharacterCardVersionStore {
  private readonly cardPath: string;
  private readonly historyPath: string;
  private card: CharacterCardV2;
  private version: number;
  private checksum: string;
  private updatedAt: string;
  private updatedBy: string;

  constructor(cardPath: string, historyPath: string) {
    this.cardPath = cardPath;
    this.historyPath = historyPath;

    this.card = loadCharacterCard(cardPath);
    const history = this.getHistory();
    this.version = history.length + 1;
    this.checksum = cardChecksum(this.card);
    this.updatedAt = history.at(-1)?.timestamp ?? new Date().toISOString();
    this.updatedBy = history.at(-1)?.updatedBy ?? 'system';
  }

  getCurrent(): CharacterCardSnapshot {
    return {
      version: this.version,
      checksum: this.checksum,
      updatedAt: this.updatedAt,
      updatedBy: this.updatedBy,
      card: cloneCard(this.card),
    };
  }

  getHistory(): CharacterCardHistoryEntry[] {
    return safeReadHistory(this.historyPath);
  }

  getHistoryEntry(version: number): CharacterCardHistoryEntry | undefined {
    return this.getHistory().find((entry) => entry.version === version);
  }

  update(nextCard: CharacterCardV2, updatedBy: string, reason?: string): CharacterCardSnapshot {
    assertValidCharacterCard(nextCard, this.cardPath);

    const previousCard = cloneCard(this.card);
    const normalizedNext = cloneCard(nextCard);
    const previousChecksum = this.checksum;
    const newChecksum = cardChecksum(normalizedNext);

    if (newChecksum === previousChecksum) {
      return this.getCurrent();
    }

    const nowIso = new Date().toISOString();
    this.appendHistory({
      version: this.version,
      timestamp: nowIso,
      updatedBy,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      previousChecksum,
      newChecksum,
      previousCard,
      newCard: cloneCard(normalizedNext),
    });

    this.persistCard(normalizedNext);
    this.card = normalizedNext;
    this.version += 1;
    this.checksum = newChecksum;
    this.updatedAt = nowIso;
    this.updatedBy = updatedBy;

    return this.getCurrent();
  }

  updateData(patch: CharacterCardPatch, updatedBy: string, reason?: string): CharacterCardSnapshot {
    if (!hasPatchFields(patch)) {
      throw new Error('Character card patch must include at least one field.');
    }

    const nextData = applyPatchToCharacterData(this.card.data, patch);

    const nextCard: CharacterCardV2 = {
      ...this.card,
      data: nextData,
    };

    return this.update(nextCard, updatedBy, reason);
  }

  rollback(version: number, updatedBy = 'admin:rollback'): CharacterCardSnapshot {
    const entry = this.getHistoryEntry(version);
    if (!entry) {
      throw new Error(`No character card history entry for version ${version}`);
    }

    return this.update(entry.previousCard, updatedBy, `Rollback to version ${version}`);
  }

  private persistCard(card: CharacterCardV2): void {
    writeJsonAtomic(this.cardPath, card);
  }

  private appendHistory(entry: CharacterCardHistoryEntry): void {
    appendJsonLine(this.historyPath, entry);
  }
}

export interface PersonaUpdateToolOptions {
  getCapabilityTier?: () => CapabilityTier;
  confirmationQueue?: ConfirmationQueue;
}

function proposalScope(snapshot: CharacterCardSnapshot): string {
  return `${snapshot.card.data.name} (v${snapshot.version})`;
}

function proposalReason(reason: string | undefined, tier: CapabilityTier): string {
  if (reason?.trim()) return reason.trim();
  return `Character card update proposed by ${tier} tier`;
}

function enqueueCharacterCardUpdateProposal(
  store: CharacterCardVersionStore,
  confirmationQueue: ConfirmationQueue,
  patch: CharacterCardPatch,
  tier: CapabilityTier,
  reason?: string,
  companionReasonPrefix?: string,
): ConfirmationQueueEntry {
  const current = store.getCurrent();
  const companionReason = companionReasonPrefix
    ? `${companionReasonPrefix} ${proposalReason(reason, tier)}`
    : proposalReason(reason, tier);

  return confirmationQueue.enqueue(
    {
      method: 'identity.card.update',
      action: 'update',
      scope: proposalScope(current),
      params: {
        ...patch,
        ...(reason ? { reason } : {}),
      },
      companionReason,
    },
    async (approvedParams: Record<string, unknown>, queueEntry: ConfirmationQueueEntry) => {
      const approvedPatch = extractCardPatchFromRecord(approvedParams);
      if (!hasPatchFields(approvedPatch)) {
        throw new Error('Approved character card proposal must include at least one field.');
      }
      const approvedReason = typeof approvedParams.reason === 'string'
        ? approvedParams.reason
        : queueEntry.companionReason;
      store.updateData(approvedPatch, 'admin:confirmation', approvedReason);
    },
  );
}

export function createPersonaUpdateTool(
  store: CharacterCardVersionStore,
  options: PersonaUpdateToolOptions = {},
): AgentTool<any> {
  const getCapabilityTier = options.getCapabilityTier ?? (() => 'autonomous' as CapabilityTier);
  const confirmationQueue = options.confirmationQueue;

  const tool: AgentTool<any> = {
    name: 'persona_update',
    description:
      'Dangerous: persona edits can radically alter or erase the companion\'s identity. '
      + 'Protected persona fields require human confirmation; only low-risk metadata edits may apply autonomously.',
    label: 'persona_update',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Updated character name.' })),
      description: Type.Optional(Type.String({ description: 'Updated character description.' })),
      personality: Type.Optional(Type.String({ description: 'Updated character personality.' })),
      scenario: Type.Optional(Type.String({ description: 'Updated character scenario.' })),
      first_mes: Type.Optional(Type.String({ description: 'Updated first message seed.' })),
      mes_example: Type.Optional(Type.String({ description: 'Updated dialogue example.' })),
      system_prompt: Type.Optional(Type.String({ description: 'Updated system prompt section.' })),
      post_history_instructions: Type.Optional(Type.String({ description: 'Updated post-history instructions.' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Updated tag list.' })),
      creator: Type.Optional(Type.String({ description: 'Updated creator attribution.' })),
      creator_notes: Type.Optional(Type.String({ description: 'Updated creator notes.' })),
      allow_destructive_replace: Type.Optional(Type.Boolean({
        description:
          'Set true only when intentionally replacing most of a long field instead of appending or lightly editing it.',
      })),
      reason: Type.Optional(Type.String({ description: 'Short rationale for the mutation.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const patch = extractCardPatchFromRecord(params);
      if (!hasPatchFields(patch)) {
        return textResultWithError('Provide at least one persona field to update.', true);
      }

      const reason = typeof params.reason === 'string' ? params.reason : undefined;
      const tier = getCapabilityTier();

      if (tier === 'autonomous') {
        const protectedAutonomousFields = resolveProtectedAutonomousUpdateFields(patch);
        if (protectedAutonomousFields.length > 0) {
          if (!confirmationQueue) {
            return textResultWithError(
              'Protected persona fields require confirmation queue support: '
              + `${formatProtectedAutonomousUpdateFields(protectedAutonomousFields)}.`,
              true,
            );
          }

          const entry = enqueueCharacterCardUpdateProposal(
            store,
            confirmationQueue,
            patch,
            tier,
            reason,
            `Protected identity fields (${formatProtectedAutonomousUpdateFields(protectedAutonomousFields)}) require operator confirmation.`,
          );
          return textResult(
            `Persona update queued for confirmation (id: ${entry.id}). `
            + `Protected identity fields (${formatProtectedAutonomousUpdateFields(protectedAutonomousFields)}) cannot be updated autonomously.`,
          );
        }

        const destructivePatchRisks = detectDestructivePatchRisks(store.getCurrent().card.data, patch);
        const allowDestructiveReplace = params.allow_destructive_replace === true;

        if (destructivePatchRisks.length > 0 && !allowDestructiveReplace) {
          return textResultWithError(
            'Dangerous persona update blocked: '
            + `${formatDestructivePatchRisks(destructivePatchRisks)}. `
            + 'Retry with allow_destructive_replace=true only if you intend to replace the full field content.',
            true,
          );
        }

        try {
          const snapshot = store.updateData(patch, 'agent', reason);
          return textResult(
            `Updated persona to v${snapshot.version} (checksum: ${snapshot.checksum}).`,
          );
        } catch (error) {
          const message = toErrorMessage(error);
          return textResultWithError(`Persona update failed: ${message}`, true);
        }
      }

      if (!confirmationQueue) {
        return textResultWithError(
          `Persona updates in ${tier} tier require confirmation queue support, but no queue is configured.`,
          true,
        );
      }

      const entry = enqueueCharacterCardUpdateProposal(
        store,
        confirmationQueue,
        patch,
        tier,
        reason,
      );

      return textResult(
        `Persona update queued for confirmation (id: ${entry.id}). ` +
        'Use the admin Confirmations page to approve, deny, or modify.',
      );
    },
  };

  return withCapabilityRequirement(tool, 'identity.write.runtime');
}

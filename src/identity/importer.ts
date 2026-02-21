import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  parseCard,
  type CCv3Data,
  type ContainerFormat,
  type SourceFormat,
  type Spec,
} from '@character-foundry/character-foundry/loader';
import type { CharacterCardV2 } from './types.js';

interface ParseMetadata {
  containerFormat: ContainerFormat;
  sourceFormat: SourceFormat;
  spec: Spec;
  warnings: string[];
}

export interface CharacterImportResult extends ParseMetadata {
  sourcePath: string;
  card: CharacterCardV2;
}

export interface CharacterImportWriteResult extends CharacterImportResult {
  destinationPath: string;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function requireRuntimeFields(data: CharacterCardV2['data']): void {
  if (!data.name.trim()) {
    throw new Error('Imported card is missing required name');
  }
  if (!data.personality.trim()) {
    throw new Error('Imported card is missing required personality');
  }
}

export function normalizeImportedCard(card: CCv3Data): CharacterCardV2 {
  const runtimeCard: CharacterCardV2 = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: toText(card.data.name),
      description: toText(card.data.description),
      personality: toText(card.data.personality) || toText(card.data.description),
      scenario: toText(card.data.scenario),
      first_mes: toText(card.data.first_mes),
      mes_example: toText(card.data.mes_example),
      system_prompt: toText(card.data.system_prompt),
      post_history_instructions: toText(card.data.post_history_instructions),
      tags: toTextArray(card.data.tags),
      creator: toText(card.data.creator),
      ...(toText(card.data.creator_notes)
        ? { creator_notes: toText(card.data.creator_notes) }
        : {}),
    },
  };

  requireRuntimeFields(runtimeCard.data);
  return runtimeCard;
}

export function parseImportedCharacterCard(raw: Uint8Array): Omit<CharacterImportResult, 'sourcePath'> {
  const parsed = parseCard(raw);
  return {
    card: normalizeImportedCard(parsed.card),
    containerFormat: parsed.containerFormat,
    sourceFormat: parsed.sourceFormat,
    spec: parsed.spec,
    warnings: parsed.warnings ?? [],
  };
}

export function importCharacterCardFromPath(sourcePath: string): CharacterImportResult {
  const resolvedPath = resolve(sourcePath);
  const raw = readFileSync(resolvedPath);
  return {
    sourcePath: resolvedPath,
    ...parseImportedCharacterCard(raw),
  };
}

export function writeNormalizedCharacterCard(path: string, card: CharacterCardV2): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`, 'utf-8');
}

export function importCharacterCardToPath(
  sourcePath: string,
  destinationPath: string,
): CharacterImportWriteResult {
  const resolvedDestination = resolve(destinationPath);
  const imported = importCharacterCardFromPath(sourcePath);
  writeNormalizedCharacterCard(resolvedDestination, imported.card);
  return {
    ...imported,
    destinationPath: resolvedDestination,
  };
}

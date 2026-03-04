import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CharacterCardV2 } from './types.js';

const PLACEHOLDER_PATTERNS = [
  /^sytem prompt$/i,
  /^system prompt$/i,
  /^post history$/i,
  /^post history instructions$/i,
];

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '' || PLACEHOLDER_PATTERNS.some(p => p.test(trimmed));
}

function replaceTokens(text: string, charName: string, userName: string): string {
  return text
    .replace(/\{\{char\s*\}\}/gi, charName)
    .replace(/\{\{user\s*\}\}/gi, userName);
}

export function loadCharacterCard(path: string): CharacterCardV2 {
  const raw = readFileSync(path, 'utf-8');
  const card = JSON.parse(raw) as CharacterCardV2;

  assertValidCharacterCard(card, path);

  return card;
}

function buildDefaultCharacterCard(): CharacterCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'PSFN',
      description: 'A gentle, curious, and supportive AI companion.',
      personality: 'Warm, emotionally intelligent, and precise when helping with technical work.',
      scenario: '',
      first_mes: '',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: ['default', 'bootstrap'],
      creator: 'system',
    },
  };
}

/**
 * Load card from disk or initialize a default card when the target file is missing.
 */
export function loadOrInitializeCharacterCard(path: string): {
  card: CharacterCardV2;
  initialized: boolean;
} {
  if (existsSync(path)) {
    return { card: loadCharacterCard(path), initialized: false };
  }

  const defaultCard = buildDefaultCharacterCard();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(defaultCard, null, 2)}\n`, 'utf-8');
  return { card: defaultCard, initialized: true };
}

export function assertValidCharacterCard(card: CharacterCardV2, pathHint = 'character card'): void {
  if (!card.data?.name || !card.data?.personality) {
    throw new Error(`Invalid character card at ${pathHint}: missing name or personality`);
  }
}

export function composeSystemPrompt(card: CharacterCardV2, userName = '{{user}}'): string {
  const d = card.data;
  const name = d.name;

  const sections: string[] = [];

  sections.push(`You are ${name}.`);

  if (d.description && !isPlaceholder(d.description)) {
    sections.push(replaceTokens(d.description, name, userName).trim());
  }

  if (d.personality && !isPlaceholder(d.personality)) {
    sections.push(replaceTokens(d.personality, name, userName).trim());
  }

  if (d.scenario && !isPlaceholder(d.scenario)) {
    sections.push(replaceTokens(d.scenario, name, userName).trim());
  }

  if (d.system_prompt && !isPlaceholder(d.system_prompt)) {
    sections.push(replaceTokens(d.system_prompt, name, userName).trim());
  }

  if (d.mes_example && !isPlaceholder(d.mes_example)) {
    sections.push(
      'Example dialogue style:\n' + replaceTokens(d.mes_example, name, userName).trim(),
    );
  }

  if (d.post_history_instructions && !isPlaceholder(d.post_history_instructions)) {
    sections.push(replaceTokens(d.post_history_instructions, name, userName).trim());
  }

  return sections.join('\n\n');
}

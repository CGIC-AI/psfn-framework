import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CharacterCardV2 } from './types.js';
import { buildCharacterMacroMap } from './character-macro-map.js';

const PLACEHOLDER_PATTERNS = [
  /^sytem prompt$/i,
  /^system prompt$/i,
  /^post history$/i,
  /^post history instructions$/i,
];
const LEGACY_BOOTSTRAP_NAME = 'PSFN';
const LEGACY_BOOTSTRAP_DESCRIPTION = 'A gentle, curious, and supportive AI companion.';
const LEGACY_BOOTSTRAP_PERSONALITY = 'Warm, emotionally intelligent, and precise when helping with technical work.';
const SYSTEM_PROMPT_TEMPLATE = [
  'You are {{char}}.',
  '',
  '{{description}}',
  '',
  '{{personality}}',
  '',
  '{{scenario}}',
  '',
  '{{system_prompt}}',
  '',
  '{{mes_example}}',
  '',
  '{{post_history_instructions}}',
].join('\n');

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
      name: 'Companion',
      description: 'A new companion identity waiting to be customized.',
      personality: 'A blank starter personality. Customize or import a full character card before regular use.',
      scenario: '',
      first_mes: '',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: ['bootstrap'],
      creator: 'system',
    },
  };
}

export function isBootstrapStarterCard(card: CharacterCardV2): boolean {
  return card.data.creator === 'system'
    && Array.isArray(card.data.tags)
    && card.data.tags.includes('bootstrap');
}

function isLegacyBootstrapDefaultCard(card: CharacterCardV2): boolean {
  const tags = Array.isArray(card.data.tags) ? card.data.tags : [];
  return card.data.creator === 'system'
    && card.data.name === LEGACY_BOOTSTRAP_NAME
    && card.data.description === LEGACY_BOOTSTRAP_DESCRIPTION
    && card.data.personality === LEGACY_BOOTSTRAP_PERSONALITY
    && tags.includes('bootstrap')
    && tags.includes('default');
}

function writeCharacterCard(path: string, card: CharacterCardV2): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`, 'utf-8');
}

function cleanField(value: string | undefined): string {
  if (!value) return '';
  return isPlaceholder(value) ? '' : value;
}

export function composeSystemPromptTemplate(): string {
  return SYSTEM_PROMPT_TEMPLATE;
}

export function buildCharacterPromptTemplateVariables(card: CharacterCardV2): Record<string, string> {
  return buildCharacterMacroMap(card);
}

/**
 * Load card from disk or initialize a default card when the target file is missing.
 */
export function loadOrInitializeCharacterCard(path: string): {
  card: CharacterCardV2;
  initialized: boolean;
  migratedLegacyBootstrap: boolean;
} {
  if (existsSync(path)) {
    const loadedCard = loadCharacterCard(path);
    if (isLegacyBootstrapDefaultCard(loadedCard)) {
      const migratedCard = buildDefaultCharacterCard();
      writeCharacterCard(path, migratedCard);
      return {
        card: migratedCard,
        initialized: false,
        migratedLegacyBootstrap: true,
      };
    }
    return {
      card: loadedCard,
      initialized: false,
      migratedLegacyBootstrap: false,
    };
  }

  const defaultCard = buildDefaultCharacterCard();
  writeCharacterCard(path, defaultCard);
  return {
    card: defaultCard,
    initialized: true,
    migratedLegacyBootstrap: false,
  };
}

export function assertValidCharacterCard(card: CharacterCardV2, pathHint = 'character card'): void {
  if (!card.data.name || !card.data.personality) {
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

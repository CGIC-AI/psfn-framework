import { existsSync, readFileSync } from 'node:fs';
import type { CharacterCardV2 } from './types.js';
import { buildCharacterMacroMap } from './character-macro-map.js';
import { normalizeCompanionName } from './companion-naming.js';
import { renderPromptRuntimeTokens } from './prompt-runtime.js';
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

export function loadCharacterCard(path: string): CharacterCardV2 {
  if (!existsSync(path)) {
    throw new Error(`Missing character card at ${path}: explicit companion identity is required before startup`);
  }

  const raw = readFileSync(path, 'utf-8');
  let card: CharacterCardV2;
  try {
    card = JSON.parse(raw) as CharacterCardV2;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid character card at ${path}: ${detail}`);
  }

  assertValidCharacterCard(card, path);

  return card;
}

export function isBootstrapStarterCard(card: CharacterCardV2): boolean {
  return card.data.creator === 'system'
    && Array.isArray(card.data.tags)
    && card.data.tags.includes('bootstrap');
}

export function composeSystemPromptTemplate(): string {
  return SYSTEM_PROMPT_TEMPLATE;
}

export function buildCharacterPromptTemplateVariables(card: CharacterCardV2): Record<string, string> {
  return buildCharacterMacroMap(card);
}

function renderWithCharacterMacros(
  template: string,
  variables: Record<string, string>,
): string {
  return renderPromptRuntimeTokens(template, { variables }).text.trim();
}

export function loadOrInitializeCharacterCard(path: string): CharacterCardV2 {
  return loadCharacterCard(path);
}

export function assertValidCharacterCard(card: CharacterCardV2, pathHint = 'character card'): void {
  if (!card.data.name || !card.data.personality) {
    throw new Error(`Invalid character card at ${pathHint}: missing name or personality`);
  }
}

export function composeSystemPrompt(card: CharacterCardV2, userName = '{{user}}'): string {
  const characterVariables = buildCharacterPromptTemplateVariables(card);
  const runtimeCharacterName = normalizeCompanionName(characterVariables.char, card.data.name);
  const runtimeVariables = {
    ...characterVariables,
    user: userName,
    user_name: userName,
    char: runtimeCharacterName,
    char_name: runtimeCharacterName,
    character: runtimeCharacterName,
    character_name: runtimeCharacterName,
  };

  const sections: string[] = [];
  sections.push(`You are ${runtimeCharacterName}.`);

  const appendRenderedMacro = (macroValue: string | undefined): void => {
    if (!macroValue) return;
    const rendered = renderWithCharacterMacros(macroValue, runtimeVariables);
    if (rendered.length > 0) sections.push(rendered);
  };

  appendRenderedMacro(characterVariables.description);
  appendRenderedMacro(characterVariables.personality);
  appendRenderedMacro(characterVariables.scenario);
  appendRenderedMacro(characterVariables.system_prompt);

  const messageExample = renderWithCharacterMacros(
    characterVariables['character.mes_example'] ?? '',
    runtimeVariables,
  );
  if (messageExample.length > 0) {
    sections.push(`Example dialogue style:\n${messageExample}`);
  }

  appendRenderedMacro(characterVariables.post_history_instructions);

  return sections.join('\n\n');
}

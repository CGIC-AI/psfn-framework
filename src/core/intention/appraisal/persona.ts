import { renderPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import type { AppraisalPersonaContext } from './types.js';

function pickFirstTrimmedString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function renderPersonaField(
  value: string | undefined,
  variables: Record<string, string>,
): string | undefined {
  if (!value) return undefined;
  const rendered = renderPromptRuntimeTokens(value, { variables }).text.trim();
  return rendered.length > 0 ? rendered : undefined;
}

export function buildAppraisalPersonaContext(
  characterPromptVariables: Record<string, string>,
  fallbackCharacterName?: string,
): AppraisalPersonaContext | null {
  const name = pickFirstTrimmedString(
    characterPromptVariables['character.name'],
    characterPromptVariables.char_name,
    characterPromptVariables.character_name,
    characterPromptVariables.name,
    fallbackCharacterName,
  );
  const renderVariables: Record<string, string> = {
    ...characterPromptVariables,
    ...(name ? {
      char: name,
      char_name: name,
      character: name,
      character_name: name,
      name,
      'character.name': name,
    } : {}),
    user: 'the user',
    user_name: 'the user',
  };

  const description = renderPersonaField(
    pickFirstTrimmedString(
      characterPromptVariables['character.description'],
      characterPromptVariables.description,
    ),
    renderVariables,
  );
  const personality = renderPersonaField(
    pickFirstTrimmedString(
      characterPromptVariables['character.personality'],
      characterPromptVariables.personality,
    ),
    renderVariables,
  );
  const scenario = renderPersonaField(
    pickFirstTrimmedString(
      characterPromptVariables['character.scenario'],
      characterPromptVariables.scenario,
    ),
    renderVariables,
  );
  const messageExample = renderPersonaField(
    pickFirstTrimmedString(
      characterPromptVariables['character.mes_example'],
      characterPromptVariables.mes_example,
    ),
    renderVariables,
  );
  const postHistoryInstructions = renderPersonaField(
    pickFirstTrimmedString(
      characterPromptVariables['character.post_history_instructions'],
      characterPromptVariables.post_history_instructions,
    ),
    renderVariables,
  );
  const visualDescription = renderPersonaField(
    pickFirstTrimmedString(
      characterPromptVariables['character.visual_description'],
      characterPromptVariables.visual_description,
      characterPromptVariables.extensions_visual_description,
    ),
    renderVariables,
  );

  const persona: AppraisalPersonaContext = {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(personality ? { personality } : {}),
    ...(scenario ? { scenario } : {}),
    ...(messageExample ? { messageExample } : {}),
    ...(postHistoryInstructions ? { postHistoryInstructions } : {}),
    ...(visualDescription ? { visualDescription } : {}),
  };

  return Object.keys(persona).length > 0 ? persona : null;
}

export function buildRuntimeAppraisalSystemPrompt(
  basePrompt: string,
  persona: AppraisalPersonaContext | null,
): string {
  if (!persona) {
    return basePrompt;
  }

  const personaLines = [
    persona.name ? `Name: ${persona.name}` : null,
    persona.description ? `Description: ${persona.description}` : null,
    persona.personality ? `Personality: ${persona.personality}` : null,
    persona.scenario ? `Scenario: ${persona.scenario}` : null,
    persona.visualDescription ? `Appearance: ${persona.visualDescription}` : null,
    persona.messageExample ? `Example dialogue style:\n${persona.messageExample}` : null,
    persona.postHistoryInstructions ? `Post-history instructions: ${persona.postHistoryInstructions}` : null,
  ].filter((line): line is string => Boolean(line));

  if (personaLines.length === 0) {
    return basePrompt;
  }

  return [
    basePrompt,
    'Current companion persona context for Whisper notes to self:',
    ...personaLines,
  ].join('\n\n');
}

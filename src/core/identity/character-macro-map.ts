import type { CharacterCardV2 } from './types.js';

const PLACEHOLDER_PATTERNS = [
  /^sytem prompt$/i,
  /^system prompt$/i,
  /^post history$/i,
  /^post history instructions$/i,
];

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '' || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function cleanField(value: string | undefined): string {
  if (!value) return '';
  return isPlaceholder(value) ? '' : value;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function stringifyExtensionValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value) && value.every((entry) => entry == null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' || typeof entry === 'bigint')) {
    return value.filter((entry): entry is string | number | boolean | bigint => entry != null).map(String).join('\n');
  }
  return null;
}

function flattenExtensionFields(
  value: unknown,
  path: string[],
  output: Map<string, string>,
): void {
  const primitive = stringifyExtensionValue(value);
  if (primitive != null) {
    const dotted = path.join('.');
    if (!dotted) return;
    output.set(dotted, primitive);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) continue;
    flattenExtensionFields(nested, [...path, key], output);
  }
}

export function buildCharacterMacroMap(card: CharacterCardV2): Record<string, string> {
  const data = card.data;
  const name = cleanField(data.name);
  const description = cleanField(data.description);
  const personality = cleanField(data.personality);
  const scenario = cleanField(data.scenario);
  const systemPrompt = cleanField(data.system_prompt);
  const messageExample = cleanField(data.mes_example);
  const postHistoryInstructions = cleanField(data.post_history_instructions);
  const firstMessage = cleanField(data.first_mes);
  const creator = cleanField(data.creator);
  const creatorNotes = cleanField(data.creator_notes);
  const tags = Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string').join(', ') : '';
  const alternateGreetings = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.filter((greeting) => typeof greeting === 'string').join('\n')
    : '';

  const extensionFields = new Map<string, string>();
  if (data.extensions && typeof data.extensions === 'object') {
    flattenExtensionFields(data.extensions, [], extensionFields);
  }
  const visualDescription = cleanField(extensionFields.get('visual_description'));

  const variables: Record<string, string> = {
    name,
    char: name,
    char_name: name,
    character: name,
    character_name: name,
    description,
    personality,
    scenario,
    system_prompt: systemPrompt,
    post_history_instructions: postHistoryInstructions,
    mes_example: messageExample ? `Example dialogue style:\n${messageExample}` : '',
    first_mes: firstMessage,
    creator,
    creator_notes: creatorNotes,
    tags,
    alternate_greetings: alternateGreetings,
    visual_description: visualDescription,
    extensions_visual_description: visualDescription,
    'character.name': name,
    'character.description': description,
    'character.personality': personality,
    'character.scenario': scenario,
    'character.system_prompt': systemPrompt,
    'character.post_history_instructions': postHistoryInstructions,
    'character.mes_example': messageExample,
    'character.first_mes': firstMessage,
    'character.creator': creator,
    'character.creator_notes': creatorNotes,
    'character.tags': tags,
    'character.alternate_greetings': alternateGreetings,
    'character.visual_description': visualDescription,
  };

  for (const [dottedKey, fieldValue] of extensionFields.entries()) {
    const cleaned = cleanField(fieldValue);
    const snakeKey = toSnakeCase(dottedKey);
    variables[`extensions_${snakeKey}`] = cleaned;
    variables[`character.extensions.${dottedKey}`] = cleaned;
  }

  return variables;
}

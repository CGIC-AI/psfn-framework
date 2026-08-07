const PERSONA_OWNER_PATH_CLASSES = [
  'character_card',
  'character_card_history',
  'prompt_layers',
  'prompt_history',
  'prompt_last_known_good',
  'prompt_registry',
  'prompt_registry_history',
  'prompt_runtime_layout',
  'persona_owner_container',
] as const;

export type PersonaOwnerPathClass = (typeof PERSONA_OWNER_PATH_CLASSES)[number];

const PERSONA_OWNER_PATH_CLASS_SET: ReadonlySet<string> = new Set(PERSONA_OWNER_PATH_CLASSES);

export function isPersonaOwnerPathClass(value: unknown): value is PersonaOwnerPathClass {
  return typeof value === 'string' && PERSONA_OWNER_PATH_CLASS_SET.has(value);
}

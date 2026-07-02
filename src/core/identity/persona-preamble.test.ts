import { describe, expect, it } from 'vitest';
import {
  compressPersonaSummary,
  createPersonaPreambleService,
  type PersonaPreambleRegistryReader,
} from './persona-preamble.js';
import {
  SUBSYSTEM_PERSONA_SEEDS,
  SUBSYSTEM_PERSONA_TEMPLATE_KEY,
  buildSubsystemPersonaPromptSeeds,
  getSubsystemPersonaSeed,
} from './persona-preamble-seeds.js';

// A mutable in-memory registry reader that starts from the seed defaults, so a
// test can override the template or a per-subsystem entry the way an operator
// would through Garden and assert the assembled preamble changes.
function createSeededRegistry(): PersonaPreambleRegistryReader & { set(key: string, text: string): void } {
  const entries = new Map<string, string>();
  for (const seed of buildSubsystemPersonaPromptSeeds()) {
    entries.set(seed.key, seed.text);
  }
  return {
    getByKey: (key: string) => {
      const text = entries.get(key);
      return text === undefined ? undefined : { text };
    },
    set: (key: string, text: string) => entries.set(key, text),
  };
}

const CARD_VARS = {
  char: 'Purrsephone',
  name: 'Purrsephone',
  personality: 'A warm, wry nun who tends a walled garden and grows cannabis among the herbs. Steady, earthy, unhurried; she blesses what she plants.',
  description: 'A cloistered gardener with dirt under her nails and a dry sense of humor.',
};

describe('persona preamble service', () => {
  it('renders the operator template with char, subsystem label, compressed persona, and instruction', () => {
    const registry = createSeededRegistry();
    const service = createPersonaPreambleService({
      registry,
      personaVariables: () => CARD_VARS,
    });

    const preamble = service.build('memory_extraction');
    const seed = getSubsystemPersonaSeed('memory_extraction');

    expect(preamble.startsWith("I'm Purrsephone's memory system, I'm ")).toBe(true);
    expect(preamble).toContain(`My job is to ${seed.instruction}.`);
    // Compressed persona is derived from the card, not hand-maintained.
    expect(preamble).toContain('warm, wry nun');
  });

  it('changes the assembled prompt when the registry TEMPLATE is edited (nothing hardcoded)', () => {
    const registry = createSeededRegistry();
    const service = createPersonaPreambleService({
      registry,
      personaVariables: () => CARD_VARS,
    });
    const before = service.build('memory_extraction');

    registry.set(SUBSYSTEM_PERSONA_TEMPLATE_KEY, 'As {{char}}, working as my {{subsystem}}: {{instruction}}.');
    const after = service.build('memory_extraction');

    expect(after).not.toBe(before);
    expect(after.startsWith('As Purrsephone, working as my memory system:')).toBe(true);
  });

  it('changes the assembled prompt when a per-subsystem label or instruction is edited', () => {
    const registry = createSeededRegistry();
    const service = createPersonaPreambleService({
      registry,
      personaVariables: () => CARD_VARS,
    });
    const seed = getSubsystemPersonaSeed('arc_formation');

    registry.set(seed.labelKey, 'keeper of the long threads');
    registry.set(seed.instructionKey, 'weave separate days into one story');
    const preamble = service.build('arc_formation');

    expect(preamble).toContain("I'm Purrsephone's keeper of the long threads");
    expect(preamble).toContain('My job is to weave separate days into one story.');
  });

  it('prepend() puts the preamble before the task prompt and leaves the task body intact', () => {
    const registry = createSeededRegistry();
    const service = createPersonaPreambleService({
      registry,
      personaVariables: () => CARD_VARS,
    });
    const task = 'Return strict JSON only:\n{ "segments": [] }';
    const assembled = service.prepend('topic_segmentation', task);

    expect(assembled.endsWith(task)).toBe(true);
    expect(assembled.indexOf("I'm Purrsephone's")).toBe(0);
  });

  it('falls back to seed defaults when the registry has no entry', () => {
    const emptyRegistry: PersonaPreambleRegistryReader = { getByKey: () => undefined };
    const service = createPersonaPreambleService({
      registry: emptyRegistry,
      personaVariables: () => CARD_VARS,
    });
    const preamble = service.build('profile_synthesis');
    const seed = getSubsystemPersonaSeed('profile_synthesis');

    expect(preamble).toContain(`I'm Purrsephone's ${seed.label}`);
    expect(preamble).toContain(`My job is to ${seed.instruction}.`);
  });

  it('supplies safe fallbacks when the card lacks a name or persona', () => {
    const registry = createSeededRegistry();
    const service = createPersonaPreambleService({
      registry,
      personaVariables: () => ({}),
    });
    const preamble = service.build('memory_extraction');

    expect(preamble).toContain("the companion's memory system");
    expect(preamble).toContain('still becoming who I am');
  });

  it('strips unresolved card macros so no {{token}} leaks into the framing', () => {
    const registry = createSeededRegistry();
    const service = createPersonaPreambleService({
      registry,
      personaVariables: () => ({
        char: 'Purrsephone',
        personality: 'Devoted to {{user}} and to the garden.',
      }),
    });
    const preamble = service.build('memory_extraction');

    expect(preamble).not.toContain('{{');
    expect(preamble).not.toContain('user');
  });

  it('covers every declared subsystem id', () => {
    const registry = createSeededRegistry();
    const service = createPersonaPreambleService({
      registry,
      personaVariables: () => CARD_VARS,
    });
    for (const seed of SUBSYSTEM_PERSONA_SEEDS) {
      const preamble = service.build(seed.id);
      expect(preamble.length).toBeGreaterThan(0);
      expect(preamble).toContain("I'm Purrsephone's");
    }
  });
});

describe('compressPersonaSummary', () => {
  it('takes the leading sentences and caps length', () => {
    const summary = compressPersonaSummary(
      { personality: 'One. Two. Three. Four.' },
      { maxSentences: 2 },
    );
    expect(summary).toBe('One. Two.');
  });

  it('falls back to description when personality is empty', () => {
    const summary = compressPersonaSummary({ personality: '', description: 'A quiet gardener.' });
    expect(summary).toBe('A quiet gardener.');
  });

  it('returns a graceful fallback when the card carries no persona text', () => {
    expect(compressPersonaSummary({})).toBe('still becoming who I am');
  });
});

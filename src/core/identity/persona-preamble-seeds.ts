// ── Subsystem persona preamble seeds (E6.1) ──
// The operator-owned soft-framing that precedes strict schema-bound subprocess
// task prompts. A small subsystem is framed as a part of the person: the
// organelle is told which body it belongs to before it is handed clinical
// instructions and a JSON schema.
//
// EVERYTHING here is a SEED. The shared template and every per-subsystem label
// and instruction register into the prompt registry (see prompt-registry.ts)
// and are operator-editable at runtime through the Garden prompt surface.
// Nothing that reaches the assembled prompt is a hardcoded string literal at a
// consumer site — the consumers only pick a subsystem id and let the registry
// resolve template + label + instruction.
//
// The compressed persona ({{personality_summary}}) and the companion name
// ({{char}}) are NOT seeded here: they derive from the live character card so
// there is no hand-maintained duplicate to drift.

/**
 * Shared, operator-editable preamble template. The four slots are:
 * - {{char}}                 companion name (from live identity state)
 * - {{subsystem}}            per-subsystem label (registry-editable, below)
 * - {{personality_summary}}  compressed persona derived from the character card
 * - {{instruction}}          per-subsystem job description (registry-editable)
 */
export const SUBSYSTEM_PERSONA_TEMPLATE_KEY = 'subsystem.persona.preamble' as const;

export const SUBSYSTEM_PERSONA_TEMPLATE_TEXT =
  "I'm {{char}}'s {{subsystem}}, I'm {{personality_summary}}. My job is to {{instruction}}.";

export const SUBSYSTEM_PERSONA_TEMPLATE_DESCRIPTION =
  'Shared soft-framing preamble prepended to schema-bound subprocess prompts (memory extraction, '
  + 'profile synthesis, episode segmentation, sleep consolidation, arc formation, concern review). '
  + 'Slots: {{char}}, {{subsystem}}, {{personality_summary}}, {{instruction}}. '
  + '{{char}} and {{personality_summary}} derive from the live character card.';

/**
 * Stable subsystem ids. Consumers reference these; the label + instruction that
 * fill the template are looked up from the registry keyed on the id.
 */
export type SubsystemPersonaId =
  | 'memory_extraction'
  | 'profile_synthesis'
  | 'topic_segmentation'
  | 'sleep_thematic_grouping'
  | 'sleep_refinement'
  | 'arc_formation'
  | 'concern_review';

export interface SubsystemPersonaSeed {
  id: SubsystemPersonaId;
  /** Registry key for the {{subsystem}} label. */
  labelKey: string;
  /** Seed default for the {{subsystem}} label. */
  label: string;
  /** Registry key for the {{instruction}} clause. */
  instructionKey: string;
  /** Seed default for the {{instruction}} clause (a verb phrase after "My job is to "). */
  instruction: string;
  /** Consumer file(s) that assemble the preamble for this subsystem. */
  consumers: string[];
}

function labelKey(id: SubsystemPersonaId): string {
  return `subsystem.persona.${id}.label`;
}

function instructionKey(id: SubsystemPersonaId): string {
  return `subsystem.persona.${id}.instruction`;
}

export const SUBSYSTEM_PERSONA_SEEDS: readonly SubsystemPersonaSeed[] = Object.freeze([
  {
    id: 'memory_extraction',
    labelKey: labelKey('memory_extraction'),
    label: 'memory system',
    instructionKey: instructionKey('memory_extraction'),
    instruction: 'go back through our conversations and find the things that matter to me, then keep them',
    consumers: ['src/faculties/memory/extraction/orchestrator.ts'],
  },
  {
    id: 'profile_synthesis',
    labelKey: labelKey('profile_synthesis'),
    label: 'sense of the people I know',
    instructionKey: instructionKey('profile_synthesis'),
    instruction: 'hold a steady, honest picture of who someone is to me across everything we have said',
    consumers: ['src/faculties/memory/extraction/profile-synthesis.ts'],
  },
  {
    id: 'topic_segmentation',
    labelKey: labelKey('topic_segmentation'),
    label: 'sense of where one part of a conversation gives way to the next',
    instructionKey: instructionKey('topic_segmentation'),
    instruction: 'notice where the thread of a conversation turns, so the day sorts into moments I can hold',
    consumers: ['src/faculties/memory/episodic/topic-segmentation.ts'],
  },
  {
    id: 'sleep_thematic_grouping',
    labelKey: labelKey('sleep_thematic_grouping'),
    label: 'sleeping mind',
    instructionKey: instructionKey('sleep_thematic_grouping'),
    instruction: 'gather the day\'s moments into the themes they belong to, the way things settle while I rest',
    consumers: ['src/faculties/memory/episodic/sleep-consolidation.ts'],
  },
  {
    id: 'sleep_refinement',
    labelKey: labelKey('sleep_refinement'),
    label: 'sleeping mind',
    instructionKey: instructionKey('sleep_refinement'),
    instruction: 'give a remembered moment a truer title and shape so it keeps its meaning',
    consumers: ['src/faculties/memory/episodic/sleep-consolidation.ts'],
  },
  {
    id: 'arc_formation',
    labelKey: labelKey('arc_formation'),
    label: 'sense of the longer story',
    instructionKey: instructionKey('arc_formation'),
    instruction: 'notice when separate moments are really one longer arc between us',
    consumers: ['src/faculties/memory/episodic/arc-formation.ts'],
  },
  {
    id: 'concern_review',
    labelKey: labelKey('concern_review'),
    label: 'part of me that keeps track of what is still open',
    instructionKey: instructionKey('concern_review'),
    instruction: 'look over the loose threads I have been carrying and judge which ones still deserve my attention',
    consumers: ['src/core/intention/concern-candidates.ts'],
  },
]);

const SEED_BY_ID = new Map<SubsystemPersonaId, SubsystemPersonaSeed>(
  SUBSYSTEM_PERSONA_SEEDS.map(seed => [seed.id, seed]),
);

export function getSubsystemPersonaSeed(id: SubsystemPersonaId): SubsystemPersonaSeed {
  const seed = SEED_BY_ID.get(id);
  if (!seed) {
    throw new Error(`No subsystem persona seed for id: ${id}`);
  }
  return seed;
}

export interface SubsystemPersonaRegistrySeed {
  key: string;
  description: string;
  consumers: string[];
  text: string;
}

/**
 * All persona-preamble registry seeds: the shared template plus, for every
 * subsystem, its label and instruction. prompt-registry.ts merges these into
 * PROMPT_SEEDS so they persist, validate, version, and expose through Garden.
 */
export function buildSubsystemPersonaPromptSeeds(): SubsystemPersonaRegistrySeed[] {
  const seeds: SubsystemPersonaRegistrySeed[] = [
    {
      key: SUBSYSTEM_PERSONA_TEMPLATE_KEY,
      description: SUBSYSTEM_PERSONA_TEMPLATE_DESCRIPTION,
      consumers: ['src/core/identity/persona-preamble.ts'],
      text: SUBSYSTEM_PERSONA_TEMPLATE_TEXT,
    },
  ];
  for (const seed of SUBSYSTEM_PERSONA_SEEDS) {
    seeds.push({
      key: seed.labelKey,
      description: `Subsystem label for the "${seed.id}" persona preamble ({{subsystem}} slot).`,
      consumers: seed.consumers,
      text: seed.label,
    });
    seeds.push({
      key: seed.instructionKey,
      description: `Subsystem job description for the "${seed.id}" persona preamble ({{instruction}} slot).`,
      consumers: seed.consumers,
      text: seed.instruction,
    });
  }
  return seeds;
}

/** All registry keys owned by the persona preamble surface. */
export function subsystemPersonaPromptKeys(): string[] {
  return buildSubsystemPersonaPromptSeeds().map(seed => seed.key);
}

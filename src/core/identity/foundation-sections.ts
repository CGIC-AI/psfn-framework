import {
  normalizePromptSectionId,
  unwrapSingleWrappedPromptSection,
  wrapPromptSectionXml,
} from './prompt-sections.js';

export const FOUNDATION_SECTION_DEFINITIONS = [
  {
    id: 'identity',
    title: 'Identity',
    layerName: 'Character Foundation · Identity',
    identifier: 'main',
    promptOrder: 0,
    priority: 0,
    defaultContent: 'You are {{char}}.',
    defaultEnabled: true,
  },
  {
    id: 'description',
    title: 'Description',
    layerName: 'Character Foundation · Description',
    identifier: 'charDescription',
    promptOrder: 10,
    priority: 10,
    defaultContent: '{{description}}',
    defaultEnabled: true,
  },
  {
    id: 'personality',
    title: 'Personality',
    layerName: 'Character Foundation · Personality',
    identifier: 'charPersonality',
    promptOrder: 20,
    priority: 20,
    defaultContent: '{{personality}}',
    defaultEnabled: true,
  },
  {
    id: 'scenario',
    title: 'Scenario',
    layerName: 'Character Foundation · Scenario',
    identifier: 'scenario',
    promptOrder: 30,
    priority: 30,
    defaultContent: '{{scenario}}',
    defaultEnabled: true,
  },
  {
    id: 'system_prompt',
    title: 'System Prompt',
    layerName: 'Character Foundation · System Prompt',
    identifier: 'systemPrompt',
    promptOrder: 40,
    priority: 40,
    defaultContent: '{{system_prompt}}',
    defaultEnabled: true,
  },
  {
    id: 'post_history_instructions',
    title: 'Post-History Instructions',
    layerName: 'Character Foundation · Post-History Instructions',
    identifier: 'postHistoryInstructions',
    promptOrder: 50,
    priority: 50,
    defaultContent: '{{post_history_instructions}}',
    defaultEnabled: true,
  },
  {
    id: 'mes_example',
    title: 'Message Example',
    layerName: 'Character Foundation · Message Example',
    identifier: 'dialogueExamples',
    promptOrder: 60,
    priority: 60,
    defaultContent: '{{mes_example}}',
    defaultEnabled: false,
  },
  {
    id: 'first_mes',
    title: 'First Message',
    layerName: 'Character Foundation · First Message',
    identifier: 'firstMessage',
    promptOrder: 70,
    priority: 70,
    defaultContent: '{{first_mes}}',
    defaultEnabled: false,
  },
] as const;

export type FoundationSectionId = (typeof FOUNDATION_SECTION_DEFINITIONS)[number]['id'];

export interface FoundationSectionState {
  id: FoundationSectionId;
  title: string;
  content: string;
  enabled: boolean;
  defaultEnabled: boolean;
}

const FOUNDATION_SECTION_ID_SET = new Set<FoundationSectionId>(
  FOUNDATION_SECTION_DEFINITIONS.map(section => section.id),
);

const WRAPPED_PROMPT_SECTION_PATTERN = /<([a-z0-9_]+)>\n?([\s\S]*?)<\/\1>/g;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function trimSurroundingBlankLines(value: string): string {
  const lines = normalizeLineEndings(value).split('\n');
  let start = 0;
  while (start < lines.length && lines[start]?.trim() === '') start += 1;
  let end = lines.length;
  while (end > start && lines[end - 1]?.trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

function isFoundationSectionId(value: string): value is FoundationSectionId {
  return FOUNDATION_SECTION_ID_SET.has(value as FoundationSectionId);
}

function resolveFoundationSectionDefinition(id: FoundationSectionId) {
  return FOUNDATION_SECTION_DEFINITIONS.find(section => section.id === id)!;
}

export function getFoundationSectionDefinitionById(id: FoundationSectionId) {
  return resolveFoundationSectionDefinition(id);
}

function createSectionState(
  id: FoundationSectionId,
  overrides?: Partial<Pick<FoundationSectionState, 'content' | 'enabled'>>,
): FoundationSectionState {
  const definition = resolveFoundationSectionDefinition(id);
  return {
    id,
    title: definition.title,
    content: overrides?.content ?? definition.defaultContent,
    enabled: overrides?.enabled ?? definition.defaultEnabled,
    defaultEnabled: definition.defaultEnabled,
  };
}

function createOrderedSectionState(
  orderedIds: FoundationSectionId[],
  enabledById: Partial<Record<FoundationSectionId, boolean>>,
  contentById: Partial<Record<FoundationSectionId, string>>,
): FoundationSectionState[] {
  const seen = new Set<FoundationSectionId>();
  const ordered = orderedIds
    .filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(id => createSectionState(id, {
      content: contentById[id],
      enabled: enabledById[id],
    }));

  for (const definition of FOUNDATION_SECTION_DEFINITIONS) {
    if (seen.has(definition.id)) continue;
    ordered.push(createSectionState(definition.id, {
      content: contentById[definition.id],
      enabled: enabledById[definition.id],
    }));
  }

  return ordered;
}

function composeLegacyFoundationTemplate(): string {
  return [
    'identity',
    'description',
    'personality',
    'scenario',
    'system_prompt',
    'mes_example',
    'post_history_instructions',
  ]
    .map(id => resolveFoundationSectionDefinition(id as FoundationSectionId).defaultContent)
    .join('\n\n');
}

export function createDefaultFoundationSections(): FoundationSectionState[] {
  return FOUNDATION_SECTION_DEFINITIONS.map(section => createSectionState(section.id));
}

export function composeFoundationSectionTemplate(section: Pick<FoundationSectionState, 'id' | 'content'>): string {
  return wrapPromptSectionXml({
    id: section.id,
    title: resolveFoundationSectionDefinition(section.id).title,
    content: section.content,
  });
}

export function composeFoundationSections(
  sections: readonly Pick<FoundationSectionState, 'id' | 'content' | 'enabled'>[],
): string {
  return sections
    .filter(section => section.enabled)
    .map(section => composeFoundationSectionTemplate(section))
    .filter(section => section.trim().length > 0)
    .join('\n\n');
}

export function composeDefaultFoundationTemplate(): string {
  return composeFoundationSections(createDefaultFoundationSections());
}

export function decomposeFoundationSections(content: string): FoundationSectionState[] {
  const normalized = normalizeLineEndings(content).trim();
  if (!normalized) {
    return createDefaultFoundationSections();
  }

  const parsedOrder: FoundationSectionId[] = [];
  const contentById: Partial<Record<FoundationSectionId, string>> = {};
  let match: RegExpExecArray | null;
  while ((match = WRAPPED_PROMPT_SECTION_PATTERN.exec(normalized)) !== null) {
    const id = normalizePromptSectionId(match[1]);
    if (!isFoundationSectionId(id)) continue;
    parsedOrder.push(id);
    contentById[id] = trimSurroundingBlankLines(match[2]);
  }

  if (parsedOrder.length > 0) {
    const enabledById = Object.fromEntries(parsedOrder.map(id => [id, true])) as Partial<Record<FoundationSectionId, boolean>>;
    return createOrderedSectionState(parsedOrder, enabledById, contentById);
  }

  if (normalized === composeLegacyFoundationTemplate()) {
    return createOrderedSectionState(
      [
        'identity',
        'description',
        'personality',
        'scenario',
        'system_prompt',
        'mes_example',
        'post_history_instructions',
      ],
      {
        identity: true,
        description: true,
        personality: true,
        scenario: true,
        system_prompt: true,
        mes_example: true,
        post_history_instructions: true,
      },
      {},
    );
  }

  const matchedDefaults = FOUNDATION_SECTION_DEFINITIONS
    .map(section => ({
      id: section.id,
      index: normalized.indexOf(section.defaultContent),
    }))
    .filter(
      (
        matchEntry,
      ): matchEntry is { id: FoundationSectionId; index: number } => matchEntry.index >= 0,
    )
    .sort((left, right) => left.index - right.index);

  if (matchedDefaults.length >= 2) {
    const enabledById = Object.fromEntries(
      matchedDefaults.map(entry => [entry.id, true]),
    ) as Partial<Record<FoundationSectionId, boolean>>;
    return createOrderedSectionState(
      matchedDefaults.map(entry => entry.id),
      enabledById,
      {},
    );
  }

  return createOrderedSectionState(
    ['system_prompt'],
    { system_prompt: true },
    { system_prompt: normalized },
  );
}

export function isMacroBackedFoundationContent(content: string): boolean {
  return /\{\{\s*[\w.]+\s*\}\}/.test(content);
}

export function decomposeFoundationLayerContent(
  sectionId: FoundationSectionId,
  content: string,
): FoundationSectionState {
  const definition = resolveFoundationSectionDefinition(sectionId);
  const unwrapped = unwrapSingleWrappedPromptSection(content);
  if (unwrapped && normalizePromptSectionId(unwrapped.id) === definition.id) {
    return createSectionState(sectionId, {
      content: trimSurroundingBlankLines(unwrapped.content),
    });
  }
  return createSectionState(sectionId, {
    content: trimSurroundingBlankLines(content),
  });
}

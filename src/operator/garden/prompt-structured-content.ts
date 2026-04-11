export const STRUCTURED_PROMPT_FORMAT = 'ccv3_sections_v1';

export const STRUCTURED_PROMPT_SECTION_KEYS = [
  'description',
  'personality',
  'system_prompt',
  'post_history_instructions',
  'scenario',
  'mes_example',
  'first_mes',
] as const;

export type StructuredPromptSectionKey = (typeof STRUCTURED_PROMPT_SECTION_KEYS)[number];

export type StructuredPromptSections = Record<StructuredPromptSectionKey, string>;

export const STRUCTURED_PROMPT_SECTION_LABELS: Record<StructuredPromptSectionKey, string> = {
  description: 'Description',
  personality: 'Personality',
  system_prompt: 'System Prompt',
  post_history_instructions: 'Post-History Instructions',
  scenario: 'Scenario',
  mes_example: 'Message Example',
  first_mes: 'First Message',
};

const STRUCTURED_HEADING_PATTERN = /^###\s+([a-z_]+)\s*$/;

const EMPTY_STRUCTURED_PROMPT_SECTIONS: StructuredPromptSections = {
  description: '',
  personality: '',
  system_prompt: '',
  post_history_instructions: '',
  scenario: '',
  mes_example: '',
  first_mes: '',
};

export interface DecomposedPromptContent {
  sections: StructuredPromptSections;
  isStructured: boolean;
  errors: string[];
  warnings: string[];
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function isStructuredPromptSectionKey(value: string): value is StructuredPromptSectionKey {
  return STRUCTURED_PROMPT_SECTION_KEYS.includes(value as StructuredPromptSectionKey);
}

function trimSurroundingBlankLines(lines: string[]): string {
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start += 1;

  let end = lines.length;
  while (end > start && lines[end - 1].trim() === '') end -= 1;

  return lines.slice(start, end).join('\n');
}

export function createEmptyStructuredPromptSections(): StructuredPromptSections {
  return { ...EMPTY_STRUCTURED_PROMPT_SECTIONS };
}

function hasStructuredHeadings(lines: string[]): boolean {
  return lines.some(line => STRUCTURED_HEADING_PATTERN.test(line.trim()));
}

export function decomposePromptContent(content: string): DecomposedPromptContent {
  const sections = createEmptyStructuredPromptSections();
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split('\n');

  if (!hasStructuredHeadings(lines)) {
    sections.system_prompt = normalized.trim();
    if (sections.system_prompt.length > 0) {
      warnings.push(
        'Legacy unstructured prompt content was mapped to "system_prompt". Saving will rewrite this layer in structured section format.',
      );
    }
    return { sections, isStructured: false, errors, warnings };
  }

  const buckets: Record<StructuredPromptSectionKey, string[]> = {
    description: [],
    personality: [],
    system_prompt: [],
    post_history_instructions: [],
    scenario: [],
    mes_example: [],
    first_mes: [],
  };

  const seenSections = new Set<StructuredPromptSectionKey>();
  let currentSection: StructuredPromptSectionKey | null = null;
  let sawHeading = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = line.trim().match(STRUCTURED_HEADING_PATTERN);

    if (headingMatch) {
      sawHeading = true;
      const sectionName = headingMatch[1];
      if (!isStructuredPromptSectionKey(sectionName)) {
        errors.push(`Line ${index + 1}: unknown structured section "${sectionName}".`);
        currentSection = null;
        continue;
      }
      if (seenSections.has(sectionName)) {
        errors.push(`Line ${index + 1}: duplicate structured section "${sectionName}".`);
      } else {
        seenSections.add(sectionName);
      }
      currentSection = sectionName;
      continue;
    }

    if (!sawHeading) {
      if (line.trim().length > 0) {
        errors.push(`Line ${index + 1}: text appears before the first structured section heading.`);
      }
      continue;
    }

    if (!currentSection) {
      if (line.trim().length > 0) {
        errors.push(`Line ${index + 1}: text is not attached to a valid structured section.`);
      }
      continue;
    }

    buckets[currentSection].push(line);
  }

  for (const key of STRUCTURED_PROMPT_SECTION_KEYS) {
    sections[key] = trimSurroundingBlankLines(buckets[key]);
  }

  return { sections, isStructured: true, errors, warnings };
}

export function composePromptContent(sections: StructuredPromptSections): string {
  const chunks: string[] = [];

  for (const key of STRUCTURED_PROMPT_SECTION_KEYS) {
    const value = normalizeLineEndings(sections[key]).trim();
    if (!value) continue;
    chunks.push(`### ${key}\n${value}`);
  }

  return chunks.join('\n\n');
}

export function containsStructuredPromptSections(params: URLSearchParams): boolean {
  return STRUCTURED_PROMPT_SECTION_KEYS.some(key => params.has(key));
}

export function getMalformedStructuredPromptErrors(content: string): string[] {
  const parsed = decomposePromptContent(content);
  return parsed.isStructured ? parsed.errors : [];
}

export function parseStructuredPromptForm(
  params: URLSearchParams,
): { ok: true; content: string } | { ok: false; error: string } {
  if (!containsStructuredPromptSections(params)) {
    return { ok: false, error: 'Structured prompt fields are missing from this request.' };
  }

  const promptFormat = params.get('prompt_format');
  if (promptFormat && promptFormat !== STRUCTURED_PROMPT_FORMAT) {
    return { ok: false, error: `Unsupported prompt_format "${promptFormat}".` };
  }

  const sections = createEmptyStructuredPromptSections();
  for (const key of STRUCTURED_PROMPT_SECTION_KEYS) {
    sections[key] = params.get(key) ?? '';
  }

  const content = composePromptContent(sections);
  const malformedErrors = getMalformedStructuredPromptErrors(content);
  if (malformedErrors.length > 0) {
    return { ok: false, error: `Malformed structured prompt content: ${malformedErrors.join(' ')}` };
  }

  return { ok: true, content };
}

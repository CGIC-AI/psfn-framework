import { countTokens } from '../../primitives/llm/tokens.js';
import type { PromptSectionTelemetry } from '../../shared/contracts/runtime.js';

export interface PromptSectionInput {
  id: string;
  title?: string;
  content: string;
}

const WRAPPED_PROMPT_SECTION_PATTERN = /<([a-z0-9_]+)>\n?([\s\S]*?)<\/\1>/g;
const SINGLE_WRAPPED_PROMPT_SECTION_PATTERN = /^<([a-z0-9_]+)>\n?([\s\S]*?)<\/\1>$/;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function normalizePromptSectionId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : 'section';
}

export function humanizePromptSectionId(value: string): string {
  return normalizePromptSectionId(value)
    .split('_')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function wrapPromptSectionXml(input: PromptSectionInput): string {
  const content = normalizeLineEndings(input.content).trim();
  if (!content) return '';
  const tag = normalizePromptSectionId(input.id);
  return `<${tag}>\n${content}\n</${tag}>`;
}

export function isSingleWrappedPromptSection(text: string): boolean {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) return false;
  return SINGLE_WRAPPED_PROMPT_SECTION_PATTERN.test(normalized);
}

export interface UnwrappedPromptSection {
  id: string;
  content: string;
}

export function unwrapSingleWrappedPromptSection(text: string): UnwrappedPromptSection | null {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) return null;
  const match = normalized.match(SINGLE_WRAPPED_PROMPT_SECTION_PATTERN);
  if (!match) return null;
  return {
    id: normalizePromptSectionId(match[1]),
    content: match[2].trim(),
  };
}

export function buildPromptSectionTelemetry(
  input: PromptSectionInput,
): PromptSectionTelemetry | null {
  const wrapped = isSingleWrappedPromptSection(input.content)
    ? normalizeLineEndings(input.content).trim()
    : wrapPromptSectionXml(input);
  if (!wrapped) return null;
  return {
    id: normalizePromptSectionId(input.id),
    title: input.title?.trim() || humanizePromptSectionId(input.id),
    content: wrapped,
    charCount: wrapped.length,
    tokenCount: countTokens(wrapped),
  };
}

export function buildPromptSectionTelemetryList(
  sections: readonly PromptSectionInput[],
): PromptSectionTelemetry[] {
  return sections
    .map(section => buildPromptSectionTelemetry(section))
    .filter((section): section is PromptSectionTelemetry => section !== null);
}

export function extractWrappedPromptSections(text: string): PromptSectionTelemetry[] {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) return [];

  const sections: PromptSectionTelemetry[] = [];
  let match: RegExpExecArray | null;
  while ((match = WRAPPED_PROMPT_SECTION_PATTERN.exec(normalized)) !== null) {
    const wrapped = match[0].trim();
    const id = normalizePromptSectionId(match[1]);
    if (!wrapped) continue;
    sections.push({
      id,
      title: humanizePromptSectionId(id),
      content: wrapped,
      charCount: wrapped.length,
      tokenCount: countTokens(wrapped),
    });
  }

  return sections;
}

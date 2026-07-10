import { countTokens } from '../../primitives/llm/tokens.js';
import type { PromptSectionTelemetry } from '../../shared/contracts/runtime.js';
import { cloneAuthenticityProvenance } from '../../shared/authenticity-provenance.js';

export interface PromptSectionInput {
  id: string;
  title?: string;
  content: string;
  provenance?: PromptSectionTelemetry['provenance'];
  scopeProvenance?: PromptSectionTelemetry['scopeProvenance'];
}

/** Resolves per-block producer + scope labels for a normalized section id. */
export type PromptSectionScopeResolver = (
  sectionId: string,
) => PromptSectionTelemetry['scopeProvenance'] | undefined;

const WRAPPED_PROMPT_SECTION_PATTERN = /<([a-z0-9_.-]+)(?:\s+[^>]*)?>\n?([\s\S]*?)<\/\1>/gi;
const SINGLE_WRAPPED_PROMPT_SECTION_PATTERN = /^<([a-z0-9_.-]+)(?:\s+[^>]*)?>\n?([\s\S]*?)<\/\1>$/i;

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

/**
 * Cogsec backstop (S10 finding H6): content that contains the section's OWN
 * opening/closing tag would break the XML frame (an early `</tag>` terminates
 * the section; a nested `<tag>` forges a second one). Section producers are
 * responsible for sanitizing interpolated free-text (see
 * `sanitizePromptEmbeddedText`); this defensively neutralizes only the
 * wrapping tag itself — swapping its `<` for the frame-inert `‹` — so
 * legitimate nested markup for OTHER tags passes through unchanged.
 */
function neutralizeWrappingTagBreakout(content: string, tag: string): string {
  // `tag` comes from normalizePromptSectionId: strictly [a-z0-9_], so it is
  // safe to embed in a regex without escaping.
  const breakout = new RegExp(`<(?=\\s*/?\\s*${tag}(?:[\\s/][^<>]*)?\\s*>)`, 'gi');
  return content.replace(breakout, '‹');
}

export function wrapPromptSectionXml(input: PromptSectionInput): string {
  const content = normalizeLineEndings(input.content).trim();
  if (!content) return '';
  const tag = normalizePromptSectionId(input.id);
  return `<${tag}>\n${neutralizeWrappingTagBreakout(content, tag)}\n</${tag}>`;
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
    ...(input.provenance ? { provenance: cloneAuthenticityProvenance(input.provenance) } : {}),
    ...(input.scopeProvenance ? { scopeProvenance: { ...input.scopeProvenance } } : {}),
  };
}

export function buildPromptSectionTelemetryList(
  sections: readonly PromptSectionInput[],
): PromptSectionTelemetry[] {
  return sections
    .map(section => buildPromptSectionTelemetry(section))
    .filter((section): section is PromptSectionTelemetry => section !== null);
}

export function extractWrappedPromptSections(
  text: string,
  resolveScopeProvenance?: PromptSectionScopeResolver,
): PromptSectionTelemetry[] {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) return [];

  const sections: PromptSectionTelemetry[] = [];
  let match: RegExpExecArray | null;
  while ((match = WRAPPED_PROMPT_SECTION_PATTERN.exec(normalized)) !== null) {
    const wrapped = match[0].trim();
    const id = normalizePromptSectionId(match[1]);
    if (!wrapped) continue;
    const scopeProvenance = resolveScopeProvenance?.(id);
    sections.push({
      id,
      title: humanizePromptSectionId(id),
      content: wrapped,
      charCount: wrapped.length,
      tokenCount: countTokens(wrapped),
      ...(scopeProvenance ? { scopeProvenance } : {}),
    });
  }

  return sections;
}

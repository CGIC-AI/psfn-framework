// ── Shared formatting helpers for runtime-context section producers (E2.6) ──
// Pure string/XML helpers with no runtime dependencies. Every producer module
// in this directory builds on these; none of them read global state.

import { unwrapSingleWrappedPromptSection } from '../../../identity/prompt-sections.js';
import { escapeXmlAttribute } from '../../../../shared/utils/escaping.js';

export { escapeXmlAttribute };

export function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function formatXmlEmptyElement(tag: string, attributes: Record<string, string>): string {
  const renderedAttributes = Object.entries(attributes)
    .filter(([, value]) => value.trim().length > 0)
    .map(([key, value]) => `${key}="${escapeXmlAttribute(value)}"`)
    .join(' ');
  return renderedAttributes ? `<${tag} ${renderedAttributes} />` : `<${tag} />`;
}

export function compactPromptText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function unwrapPromptSectionBody(section: string | null | undefined): string {
  if (!section) return '';
  return unwrapSingleWrappedPromptSection(section)?.content ?? section.trim();
}

export function countNonEmptyLines(body: string): number {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .length;
}

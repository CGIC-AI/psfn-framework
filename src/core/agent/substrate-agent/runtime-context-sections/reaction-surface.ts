// ── Reaction-surface section producer (jp36.3.1.2) ──
// Renders the curated emoji reaction surface into the turn's runtime context so
// the companion knows which reactions are available and what each one signals
// (design bible §8.3, adjudication S6.1). Turns whose channel exposes no
// reaction surface render nothing.

import { sanitizePromptEmbeddedText } from '../../../../shared/utils/escaping.js';
import { wrapPromptSectionXml } from '../../../identity/prompt-sections.js';
import {
  reactionSurfaceIsEmpty,
  type ResolvedReactionSurface,
} from '../../../../channels/shared/reaction-surface.js';

export function buildReactionSurfaceContextBlock(
  surface: ResolvedReactionSurface | undefined,
): string {
  if (!surface || reactionSurfaceIsEmpty(surface)) return '';

  const lines: string[] = [];
  for (const entry of surface.standard) {
    // The emoji itself is a fixed unicode token; only the meaning is free text.
    lines.push(`- ${entry.emoji}: ${sanitizePromptEmbeddedText(entry.meaning)}`);
  }
  for (const entry of surface.custom) {
    // Cogsec: custom-emoji name and meaning are operator/guild-supplied free
    // text interpolated into this XML-framed block — sanitize so they cannot
    // break the frame or forge `[SYSTEM …]`-style text.
    const name = sanitizePromptEmbeddedText(entry.name);
    const meaning = sanitizePromptEmbeddedText(entry.meaning);
    lines.push(`- :${name}: (guild-custom): ${meaning}`);
  }

  return wrapPromptSectionXml({
    id: 'runtime_reaction_surface',
    content: [
      '[Available reactions]',
      'You may react to a message with one of these emoji as an acknowledgement instead of, or alongside, a full reply. Each line is the emoji and what it signals in this room:',
      ...lines,
      'Only react with emoji from this list. Guild-custom (house-meme) emoji carry exactly the meaning shown; never use a custom emoji that is not listed here.',
    ].join('\n'),
  });
}

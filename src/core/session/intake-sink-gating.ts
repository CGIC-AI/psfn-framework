// ── Prompt-assembly sink gate over session entries (htm9.3) ──
//
// Read-time counterpart of the record-time screening (htm9.2): before session
// entries become prompt context, every entry that carries persisted
// `intakeScreening` metadata is checked against the `prompt_assembly` sink
// gate. In enforce mode a denied entry renders as the fixed, operator-reviewed
// withheld-content placeholder instead of its content — this is defense in
// depth for content that was recorded under shadow mode (original text
// persisted) and later consumed under enforce mode, and for any surface that
// stamps envelopes without substituting text.
//
// Shadow mode never alters entries; the gate still evaluates and audits.
// Companion UX: the substitute text is the calm htm9.12 wording; nothing here
// feeds the emotion model (the placeholder carries the notice signature that
// the appraisal/memory exclusions key on).

import { createComponentLogger } from '../../shared/logger.js';
import type { SessionEntry } from './types.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../cogsec/intake-firewall-notice-templates.js';
import type { IntakeSinkGate } from '../cogsec/intake/sink-gates.js';
import {
  INTAKE_SCREENING_METADATA_KEY,
  parseIntakeScreeningMetadata,
} from './intake-screening-metadata.js';

const log = createComponentLogger('IntakeSinkGating');

const METADATA_KEY_MARKER = `"${INTAKE_SCREENING_METADATA_KEY}"`;

export interface PromptAssemblyGateSummary {
  /** Entries whose content was replaced by the withheld placeholder (enforce mode). */
  withheldEntryIds: number[];
  /** Entries whose gate verdict was deny (includes shadow-mode would-denies). */
  deniedEntryIds: number[];
}

/**
 * Apply the prompt_assembly sink gate to session entries about to enter
 * context assembly. Returns the same array when nothing changed; otherwise a
 * new array with denied entries' content replaced (enforce mode only).
 * Malformed intake metadata fails closed in enforce mode: the entry's
 * screening state is unknowable, so its content is withheld and the error is
 * logged — never swallowed.
 */
export function applyPromptAssemblySinkGate(
  entries: SessionEntry[],
  gate: IntakeSinkGate | null,
  context: { channelId: string },
): { entries: SessionEntry[]; summary: PromptAssemblyGateSummary } {
  const summary: PromptAssemblyGateSummary = { withheldEntryIds: [], deniedEntryIds: [] };
  if (!gate) return { entries, summary };

  const mutatedRef: { entries: SessionEntry[] | null } = { entries: null };
  const withholdEntry = (index: number, entry: SessionEntry): void => {
    if (gate.mode !== 'enforce') return;
    mutatedRef.entries ??= [...entries];
    mutatedRef.entries[index] = {
      ...entry,
      content: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
    };
    summary.withheldEntryIds.push(entry.id);
  };

  for (const [index, entry] of entries.entries()) {
    if (!entry.metadata || !entry.metadata.includes(METADATA_KEY_MARKER)) continue;

    let screening;
    try {
      screening = parseIntakeScreeningMetadata(entry.metadata);
    } catch (error) {
      log.error('Malformed intake screening metadata on session entry; withholding content in enforce mode', {
        channelId: context.channelId,
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
      summary.deniedEntryIds.push(entry.id);
      withholdEntry(index, entry);
      continue;
    }
    if (!screening) continue;

    const decision = gate.evaluate('prompt_assembly', screening.envelopes, {
      channelId: context.channelId,
      entryId: entry.id,
      entryRole: entry.role,
      recordedMode: screening.mode,
    });
    if (decision.verdict === 'deny') {
      summary.deniedEntryIds.push(entry.id);
      withholdEntry(index, entry);
    }
  }

  if (summary.withheldEntryIds.length > 0) {
    log.warn('Prompt assembly sink gate withheld session entry content', {
      channelId: context.channelId,
      withheldEntryIds: summary.withheldEntryIds,
    });
  }
  return { entries: mutatedRef.entries ?? entries, summary };
}

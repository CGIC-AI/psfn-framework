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
import type {
  IntakeEnvelopeSnapshot,
  IntakeSink,
} from '../../shared/contracts/intake-envelope.js';
import { isRecord } from '../../shared/utils/types.js';
import type { SessionEntry } from './types.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../cogsec/intake-firewall-notice-templates.js';
import type { IntakeScreeningService } from '../cogsec/intake/screening.js';
import type { IntakeSinkGate } from '../cogsec/intake/sink-gates.js';
import { renderMarkedContent } from '../cogsec/intake/marking.js';
import {
  INTAKE_SCREENING_METADATA_KEY,
  parseIntakeScreeningMetadata,
} from './intake-screening-metadata.js';

const log = createComponentLogger('IntakeSinkGating');

const METADATA_KEY_MARKER = `"${INTAKE_SCREENING_METADATA_KEY}"`;
// Bound synchronous prompt-assembly marking across the whole context. Entries
// beyond the budget keep their provenance wrapper but use the reduced form.
const PROMPT_ASSEMBLY_MARKING_WORK_LIMIT_CHARS = 256 * 1024;

export type SelfAuthoredMutationSink =
  | 'persona_mutation'
  | 'wiki_write'
  | 'trust_mutation';

export interface SelfAuthoredMutationIntakeRuntime {
  getIntakeSinkGate: () => IntakeSinkGate | null;
  getIntakeScreening: () => IntakeScreeningService | null;
  getActiveTurnIntakeEnvelopes: () => readonly IntakeEnvelopeSnapshot[];
}

/** Explicit dependency for tool compositions where the intake firewall is off. */
export const INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME:
SelfAuthoredMutationIntakeRuntime = Object.freeze({
  getIntakeSinkGate: () => null,
  getIntakeScreening: () => null,
  getActiveTurnIntakeEnvelopes: () => [],
});

export interface ScreenedSelfAuthoredMutation {
  allowed: boolean;
  params: Record<string, unknown>;
}

function assertSelfAuthoredMutationSink(sink: IntakeSink): asserts sink is SelfAuthoredMutationSink {
  if (sink !== 'persona_mutation' && sink !== 'wiki_write' && sink !== 'trust_mutation') {
    throw new Error(`Unsupported self-authored mutation sink: ${sink}`);
  }
}

/**
 * Screen model-authored mutation arguments before they can reach durable
 * persona, wiki, or trust state. Every string leaf gets its own envelope so
 * sanitization is applied to the exact value the sink consumes. The active
 * turn's envelopes join those proposed-content envelopes, matching managed
 * skill writes: a clean-looking derivative cannot shed hostile provenance.
 *
 * A partially wired runtime fails loudly before gate evaluation. In
 * particular, this function never calls a mutation sink with an empty
 * envelope list; doing so would silently reduce every enforce-mode mutation
 * to the sink's unscreened default.
 */
export async function screenSelfAuthoredMutation(
  sink: SelfAuthoredMutationSink,
  params: Readonly<Record<string, unknown>>,
  intake: SelfAuthoredMutationIntakeRuntime,
  context: { tool: string; action: string },
): Promise<ScreenedSelfAuthoredMutation> {
  assertSelfAuthoredMutationSink(sink);
  const gate = intake.getIntakeSinkGate();
  const screening = intake.getIntakeScreening();
  if (!gate && !screening) {
    return { allowed: true, params: structuredClone(params) };
  }
  if (!gate) {
    throw new Error(
      `Self-authored ${sink} intake screening is wired without the canonical sink gate`,
    );
  }
  if (!screening) {
    throw new Error(
      `Self-authored ${sink} sink gate is active but intake screening is unavailable; `
      + 'refusing an unscreened mutation',
    );
  }

  const proposedContentEnvelopes: IntakeEnvelopeSnapshot[] = [];

  const screenValue = async (value: unknown, path: string): Promise<unknown> => {
    if (typeof value === 'string') {
      const screened = await screening.screen(value, {
        sourceClass: 'companion_self',
        origin: { ref: `tool:${context.tool}:${context.action}:${path}` },
        scope: 'strict',
      });
      proposedContentEnvelopes.push(screened.snapshot);
      return screened.effectiveText;
    }
    if (Array.isArray(value)) {
      const screenedItems: unknown[] = [];
      for (const [index, item] of value.entries()) {
        screenedItems.push(await screenValue(item, `${path}.${String(index)}`));
      }
      return screenedItems;
    }
    if (isRecord(value)) {
      const screenedRecord: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        screenedRecord[key] = await screenValue(item, path ? `${path}.${key}` : key);
      }
      return screenedRecord;
    }
    return value;
  };

  const screenedParams = await screenValue(params, '');
  if (!isRecord(screenedParams)) {
    throw new Error(`Self-authored ${sink} mutation parameters must be an object`);
  }
  if (proposedContentEnvelopes.length === 0) {
    throw new Error(
      `Self-authored ${sink} mutation supplied no textual content to screen; `
      + 'refusing an empty-envelope sink evaluation',
    );
  }

  const activeTurnEnvelopes = intake.getActiveTurnIntakeEnvelopes();
  const envelopes = [...activeTurnEnvelopes, ...proposedContentEnvelopes];
  const decision = gate.evaluate(sink, envelopes, {
    ...context,
    activeTurnEnvelopeCount: activeTurnEnvelopes.length,
    screenedFieldCount: proposedContentEnvelopes.length,
  });
  if (decision.unscreened) {
    throw new Error(
      `Self-authored ${sink} mutation unexpectedly reached an unscreened sink-gate path`,
    );
  }
  return { allowed: decision.allowed, params: screenedParams };
}

export interface PromptAssemblyGateSummary {
  /** Entries whose content was replaced by the withheld placeholder (enforce mode). */
  withheldEntryIds: number[];
  /** Entries whose gate verdict was deny (includes shadow-mode would-denies). */
  deniedEntryIds: number[];
  /** Entries whose content was wrapped/interleaved by data marking (enforce mode; htm9.13). */
  markedEntryIds: number[];
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
  const summary: PromptAssemblyGateSummary = {
    withheldEntryIds: [],
    deniedEntryIds: [],
    markedEntryIds: [],
  };
  if (!gate) return { entries, summary };

  let remainingMarkingWorkChars = PROMPT_ASSEMBLY_MARKING_WORK_LIMIT_CHARS;
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
      continue;
    }

    // htm9.13: light-touch data marking, applied at READ time so the marker
    // never exists in persisted content and inbound re-scans only ever see
    // forged markers. Enforce mode applies the plan; shadow mode audits it.
    if (screening.marking && screening.marking.intensity !== 'none' && !screening.withheld) {
      if (gate.mode !== 'enforce') {
        log.debug('Shadow mode: data-marking plan computed but not applied', {
          channelId: context.channelId,
          entryId: entry.id,
          intensity: screening.marking.intensity,
        });
        continue;
      }
      const sourceRef = screening.envelopes[0]?.envelopeId;
      const forceReducedForm = entry.content.length > remainingMarkingWorkChars;
      if (!forceReducedForm) {
        remainingMarkingWorkChars -= entry.content.length;
      }
      mutatedRef.entries ??= [...entries];
      mutatedRef.entries[index] = {
        ...entry,
        content: renderMarkedContent(entry.content, screening.marking, {
          ...(sourceRef ? { sourceRef: `intake-envelope:${sourceRef}` } : {}),
          ...(forceReducedForm ? { forceReducedForm: true } : {}),
        }),
      };
      summary.markedEntryIds.push(entry.id);
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

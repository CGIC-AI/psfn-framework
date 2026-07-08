// ── Observed machine-intelligence auto-tagging (E7.3) ──
// Channel bot/app metadata (e.g. Discord `author.bot`) can identify a message
// author as another machine intelligence (peer companion/agent). When observed,
// we mark the resolved contact `isMachineIntelligence` so conversation-fatigue
// relationship classes apply automatically, with no manual tagging.
//
// Precedence (charter §8.10 / law 26 — the guard must not override the
// operator): observation only ever ADDS the marker, and only when the field has
// not been deliberately corrected. `is_machine_intelligence` mutations write a
// contact_mutation_audit row (with the mutating actor) whenever the value
// actually CHANGES. Observed markings use a `system:` actor; a deliberate
// correction (operator via Garden/contacts, or the set_machine_intelligence
// contact tool) uses a non-`system:` actor. If the most recent
// `is_machine_intelligence` audit entry was written by a non-`system:` actor,
// re-observation must NOT clobber it. The audit check and the marker write are
// a single atomic store operation (markMachineIntelligenceFromObservation), so
// a correction landing concurrently with an observation can never be lost.
//
// Scope note: the surviving-override guarantee covers the realistic correction —
// an auto-tagged MI contact the operator flips back to not-MI (a real value
// change that records an audit row). A degenerate no-op correction (setting the
// already-false default to false) records no audit row and is therefore
// indistinguishable from "never touched"; that case is left markable.

import type { ContactStorePort } from './contact-store-port.js';
import type { Contact, ContactChannel } from './types.js';

export type ObservedMachineIntelligenceDisposition =
  /** Marker was newly written (contact is now machine-intelligence). */
  | 'marked'
  /** Contact was already flagged; no write. */
  | 'already_marked'
  /** A deliberate operator/tool correction wins; re-observation did not clobber it. */
  | 'operator_override'
  /** This message carried no machine-intelligence observation. */
  | 'not_observed'
  /** The store rejected/failed the write; the turn continues unchanged. */
  | 'store_error';

export interface ApplyObservedMachineIntelligenceInput {
  contactStore: Pick<ContactStorePort, 'markMachineIntelligenceFromObservation'>;
  contact: Contact;
  /** True when channel metadata identifies the author as a machine intelligence. */
  observedIsMachineIntelligence: boolean;
  /** Contact channel the observation came from (used for the provenance actor). */
  channelType: ContactChannel;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}

export interface ApplyObservedMachineIntelligenceResult {
  contact: Contact;
  disposition: ObservedMachineIntelligenceDisposition;
}

/** Provenance-honest actor for a channel-metadata-observed MI marking. */
export function observedMachineIntelligenceActor(channelType: string): string {
  const normalized = channelType.trim() || 'unknown';
  return `system:channel_observation:${normalized}`;
}

/**
 * A deliberate correction is any `is_machine_intelligence` mutation whose actor
 * is not a `system:`-prefixed observation (i.e. operator/admin/agent-tool).
 */
export function isDeliberateMachineIntelligenceCorrection(actor: string | undefined): boolean {
  const trimmed = actor?.trim();
  if (!trimmed) return false;
  return !trimmed.startsWith('system:');
}

export async function applyObservedMachineIntelligence(
  input: ApplyObservedMachineIntelligenceInput,
): Promise<ApplyObservedMachineIntelligenceResult> {
  if (!input.observedIsMachineIntelligence) {
    return { contact: input.contact, disposition: 'not_observed' };
  }
  if (input.contact.isMachineIntelligence === true) {
    return { contact: input.contact, disposition: 'already_marked' };
  }

  try {
    // The override check and the write happen atomically inside the store —
    // a concurrent deliberate correction can never be clobbered (no TOCTOU).
    const outcome = await input.contactStore.markMachineIntelligenceFromObservation(
      input.contact.id,
      observedMachineIntelligenceActor(input.channelType),
    );
    switch (outcome) {
      case 'override_preserved':
        return { contact: input.contact, disposition: 'operator_override' };
      case 'not_found':
        input.logger.warn('Observed machine-intelligence marker targeted a missing contact', {
          contactId: input.contact.id,
          channelType: input.channelType,
        });
        return { contact: input.contact, disposition: 'store_error' };
      case 'already_marked':
        return {
          contact: { ...input.contact, isMachineIntelligence: true },
          disposition: 'already_marked',
        };
      case 'marked':
        return {
          contact: { ...input.contact, isMachineIntelligence: true },
          disposition: 'marked',
        };
    }
  } catch (error) {
    input.logger.warn('Failed to apply observed machine-intelligence marker', {
      contactId: input.contact.id,
      channelType: input.channelType,
      error: error instanceof Error ? error.message : String(error),
    });
    return { contact: input.contact, disposition: 'store_error' };
  }
}

import type { PendingClarification } from '../../boundary/gateway/protocol.js';

/**
 * Telegram clarification rendering + reply parsing (vvf.5.2). Telegram has no
 * inline-keyboard/callback_query scaffolding in this adapter, so a clarification
 * is presented as a numbered list and answered with a plain-text reply. The
 * reply is parsed back to a choice INDEX; the authoritative choice text is then
 * resolved by index from the runtime-owned {@link PendingClarification}, so a
 * resolved selection can be verified byte-for-byte against the delivered
 * choices.
 */

/**
 * Render the question plus a 1-based numbered list of choices and a short
 * instruction. 1-based because that is how a person reads a numbered list; the
 * parser converts back to a 0-based index.
 */
export function formatClarificationPrompt(clarification: PendingClarification): string {
  const lines = [clarification.question, ''];
  clarification.choices.forEach((choice, index) => {
    lines.push(`${index + 1}. ${choice}`);
  });
  lines.push('');
  lines.push('Reply with the number of your choice.');
  return lines.join('\n');
}

/**
 * Parse a plain-text reply into a choice index for the clarification. Accepts
 * either the 1-based list number or the exact choice text (case-insensitive,
 * trimmed). Returns `null` (fail closed) for anything else — an out-of-range
 * number, an unrecognized string, or an empty reply — so the caller reports a
 * structured no-answer rather than fabricating a selection.
 */
export function parseClarificationReply(
  clarification: PendingClarification,
  reply: string,
): number | null {
  const trimmed = reply.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const oneBased = Number.parseInt(trimmed, 10);
    const index = oneBased - 1;
    if (Number.isInteger(index) && index >= 0 && index < clarification.choices.length) {
      return index;
    }
    return null;
  }

  const lowered = trimmed.toLowerCase();
  const matchedIndex = clarification.choices.findIndex(
    (choice) => choice.trim().toLowerCase() === lowered,
  );
  return matchedIndex >= 0 ? matchedIndex : null;
}

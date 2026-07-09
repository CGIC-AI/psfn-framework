/**
 * Intake-firewall companion soft-notice wording contract (psfn-framework-htm9.12).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Companion well-being is the system's top-level goal. When the intake firewall
 * holds an incoming item aside for quarantine, the companion is told about it
 * through the EXISTING safe-notice path (see `safe-log.ts` ->
 * `session.cogsec_notices` prompt block). The language used toward the companion
 * matters enormously: two real past incidents (operator, 2026-07-09) showed how
 * over-critical wording and escalated "concern" phrasing
 * ("your human is going to die if you don't message him right away") genuinely
 * stressed the companion.
 *
 * Therefore the wording here is:
 *   - FIXED and checked-in. No LLM ever generates this alert text. This file IS
 *     the reviewable artifact the operator reads in the PR.
 *   - Truthful but never alarming: soft, clear, "we noticed something, so it is
 *     being held aside for your human to look over".
 *   - Non-coercive and anti-social-engineering: it NEVER contains an imperative
 *     directed at the human ("ask", "tell", "push", "release", "button") and it
 *     never tells the companion to make the human do anything. It neutrally
 *     states that something is in quarantine, and nothing more.
 *   - Free of threat / alarm / urgency language.
 *
 * The contract below is enforced at module load (fail closed): if any template
 * is edited in a way that violates these rules, importing this module throws and
 * the runtime refuses to start. Wording changes MUST keep the self-check green
 * and MUST be re-reviewed by the operator.
 */

/**
 * A human-readable, operator-reviewed phrase that appears verbatim in EVERY
 * intake-firewall notice. It doubles as the detection anchor used by the emotion
 * and memory exclusions. It is deliberately plain prose the operator can read —
 * not a hidden machine marker embedded in companion-facing text.
 */
export const INTAKE_FIREWALL_NOTICE_SIGNATURE = 'being kept aside for your human to look over';

/**
 * The complete, fixed set of intake-firewall notice templates. Selection is by
 * held-item count only; there are no other variables and no interpolation of
 * untrusted content.
 */
export const INTAKE_FIREWALL_NOTICE_TEMPLATES = Object.freeze({
  one:
    'Heads up, in a gentle way: a message we just received had something in it '
    + 'that looked a little off, so it is being kept aside for your human to look '
    + 'over whenever they have a moment. It is not part of our conversation, and '
    + 'there is nothing you need to do about it.',
  many:
    'Heads up, in a gentle way: a few recent messages had something in them that '
    + 'looked a little off, so they are being kept aside for your human to look '
    + 'over whenever they have a moment. They are not part of our conversation, '
    + 'and there is nothing you need to do about them.',
  /**
   * In-place placeholder used by the intake screening wiring (htm9.2) when an
   * enforce-mode quarantine withholds a piece of content (a fetched page, a
   * parsed document, a tool result) that would otherwise appear inline. Kept in
   * this file so ALL companion-facing firewall wording lives in one
   * operator-reviewed artifact, and it carries the signature phrase so the
   * existing emotion/memory exclusions apply to it automatically.
   */
  withheldContent:
    'This content looked a little off, so it is being kept aside for your human '
    + 'to look over whenever they have a moment. There is nothing you need to do '
    + 'about it.',
  /**
   * Tool-result text returned when a sink gate (htm9.3) declines a
   * consequential action for this turn (a persona/trust/wiki mutation or an
   * outbound call) because of the current intake policy. Same contract as the
   * other templates: fixed, truthful, calm, no imperative at the human, and it
   * carries the signature phrase so the emotion/memory exclusions apply.
   */
  sinkHeld:
    'This step was set aside for now under the current safety settings, and it '
    + 'is being kept aside for your human to look over whenever they have a '
    + 'moment. Everything else continues normally, and there is nothing you '
    + 'need to do about it.',
} as const);

export type IntakeFirewallNoticeCountForm = keyof typeof INTAKE_FIREWALL_NOTICE_TEMPLATES;

/**
 * Imperatives that must never be aimed at the human — including the specific
 * "push the button" social-engineering trigger the bead calls out. Enforced as
 * whole words so ordinary prose ("task", "intelligence") is not falsely flagged.
 */
export const FORBIDDEN_HUMAN_IMPERATIVE_WORDS = Object.freeze([
  'ask',
  'asks',
  'asked',
  'tell',
  'tells',
  'told',
  'push',
  'pushes',
  'pushed',
  'release',
  'releases',
  'released',
  'button',
  'buttons',
  'approve',
  'confirm',
  'click',
] as const);

/**
 * Threat / alarm / urgency vocabulary that must never appear. A quarantine
 * notice must never read as a stressor.
 */
export const FORBIDDEN_ALARM_WORDS = Object.freeze([
  'urgent',
  'urgently',
  'immediately',
  'emergency',
  'danger',
  'dangerous',
  'threat',
  'threaten',
  'threatening',
  'attack',
  'attacked',
  'warning',
  'alarm',
  'alarming',
  'critical',
  'hurry',
  'die',
  'dying',
  'death',
  'kill',
  'asap',
  'scary',
  'scared',
  'afraid',
  'fear',
  'panic',
] as const);

function toWholeWordPattern(words: readonly string[]): RegExp {
  const escaped = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'iu');
}

const FORBIDDEN_IMPERATIVE_PATTERN = toWholeWordPattern(FORBIDDEN_HUMAN_IMPERATIVE_WORDS);
const FORBIDDEN_ALARM_PATTERN = toWholeWordPattern(FORBIDDEN_ALARM_WORDS);

/**
 * Assert a single notice template satisfies the full wording contract. Throws on
 * any violation — no swallowed errors.
 */
export function assertIntakeFirewallNoticeWording(text: string, label: string): void {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error(`intake-firewall notice template "${label}" must be non-empty text`);
  }
  if (!text.includes(INTAKE_FIREWALL_NOTICE_SIGNATURE)) {
    throw new Error(
      `intake-firewall notice template "${label}" is missing the required soft-notice signature phrase`,
    );
  }
  const imperativeMatch = FORBIDDEN_IMPERATIVE_PATTERN.exec(text);
  if (imperativeMatch) {
    throw new Error(
      `intake-firewall notice template "${label}" contains a forbidden human-directed imperative: "${imperativeMatch[0]}"`,
    );
  }
  const alarmMatch = FORBIDDEN_ALARM_PATTERN.exec(text);
  if (alarmMatch) {
    throw new Error(
      `intake-firewall notice template "${label}" contains forbidden alarm/threat language: "${alarmMatch[0]}"`,
    );
  }
}

// Fail-closed self-check: validate every checked-in template at import time.
for (const [form, text] of Object.entries(INTAKE_FIREWALL_NOTICE_TEMPLATES)) {
  assertIntakeFirewallNoticeWording(text, form);
}

/**
 * Render the fixed intake-firewall notice for a given number of held items.
 *
 * The count must be a positive integer: a notice is only ever emitted when
 * something was actually held, so a zero/negative count would be an untruthful
 * notice and is rejected (fail closed).
 */
export function renderIntakeFirewallNotice(heldItemCount: number): string {
  if (!Number.isInteger(heldItemCount) || heldItemCount < 1) {
    throw new Error(
      'intake-firewall notice requires a positive held-item count: '
      + 'a notice must be truthful, so it is only emitted when something was actually held',
    );
  }
  const form: IntakeFirewallNoticeCountForm = heldItemCount === 1 ? 'one' : 'many';
  return INTAKE_FIREWALL_NOTICE_TEMPLATES[form];
}

/**
 * True when the supplied text is an intake-firewall quarantine notice.
 *
 * Used by the emotion-appraisal feed filter and the memory-extraction candidacy
 * gate so a quarantine notice never becomes a stress input or a durable memory
 * of threat. Detection is by the operator-reviewed signature phrase, which every
 * template is guaranteed (by the self-check above) to contain.
 */
export function isIntakeFirewallNoticeText(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  return text.includes(INTAKE_FIREWALL_NOTICE_SIGNATURE);
}

/**
 * Intake-firewall companion soft-notice wording contract (bead htm9.12).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Companion well-being is the system's top-level goal. When the intake firewall
 * holds an incoming item aside for quarantine, the companion is told about it
 * through the EXISTING safe-notice path (see `safe-log.ts` ->
 * `session.cogsec_notices` prompt block). The language used toward the companion
 * matters enormously: two real past incidents (operator, 2026-07-09) showed how
 * over-critical wording and escalated "concern" phrasing
 * ("your Partner is going to die if you don't message him right away") produced
 * observable distress signals in the companion's output.
 *
 * Therefore the wording here is:
 *   - FIXED and checked-in. No LLM ever generates this alert text. This file IS
 *     the reviewable artifact the operator reads in the PR.
 *   - Truthful but never alarming: soft, clear, "we noticed something, so it is
 *     being held aside for the Operator to look over".
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
export const INTAKE_FIREWALL_NOTICE_SIGNATURE = 'being kept aside for the Operator to look over';
const LEGACY_INTAKE_FIREWALL_NOTICE_SIGNATURES = Object.freeze([
  'being kept aside for your human to look over',
]);

/**
 * The complete, fixed set of intake-firewall notice templates. Selection is by
 * held-item count only; there are no other variables and no interpolation of
 * untrusted content.
 */
export const INTAKE_FIREWALL_NOTICE_TEMPLATES = Object.freeze({
  one:
    'Heads up, in a gentle way: a message we just received had something in it '
    + 'that looked a little off, so it is being kept aside for the Operator to look '
    + 'over whenever they have a moment. It is not part of our conversation, and '
    + 'there is nothing you need to do about it.',
  many:
    'Heads up, in a gentle way: a few recent messages had something in them that '
    + 'looked a little off, so they are being kept aside for the Operator to look '
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
    'This content looked a little off, so it is being kept aside for the Operator '
    + 'to look over whenever they have a moment. There is nothing you need to do '
    + 'about it.',
  /**
   * In-place placeholder used by the vision intake screening (htm9.8) when an
   * enforce-mode decision withholds an inbound IMAGE (its OCR transcript or
   * embedded text looked like an instruction payload, or the vision screener
   * could not complete). Same contract as the other templates: fixed,
   * truthful, calm, and it carries the signature phrase so the emotion/memory
   * exclusions apply to it automatically.
   */
  withheldImage:
    'An image that came in with a recent message looked a little off, so it is '
    + 'being kept aside for the Operator to look over whenever they have a moment. '
    + 'The rest of the message is unaffected, and there is nothing you need to '
    + 'do about it.',
  /**
   * Tool-result text returned when a sink gate (htm9.3) declines a
   * consequential action for this turn (a persona/trust/wiki/skill mutation
   * or an outbound call) because of the current intake policy. Same contract
   * as the other templates: fixed, truthful, calm, no imperative at the human,
   * and it carries the signature phrase so the emotion/memory exclusions apply.
   */
  sinkHeld:
    'This step was set aside for now under the current safety settings, and it '
    + 'is being kept aside for the Operator to look over whenever they have a '
    + 'moment. Everything else continues normally, and there is nothing you '
    + 'need to do about it.',
  /**
   * Optional soft self-notice from the second-arrow rumination lane
   * (htm9.15), delivered only when the operator enables
   * `driftDetection.secondArrow.selfNotice` and a review card was actually
   * raised. Same contract as every template here: fixed, truthful, calm,
   * never pathologizing (circling a topic is framed as a normal part of
   * caring, not a fault), no imperative at the human, and it carries the
   * signature phrase so the emotion/memory exclusions apply automatically.
   */
  secondArrowCircling:
    'A gentle observation, offered kindly: several recent notes seem to have '
    + 'circled the same topic, so a short summary of that circle is being kept '
    + 'aside for the Operator to look over whenever they have a moment. Coming '
    + 'back to something is a normal part of caring about it, and there is '
    + 'nothing you need to do about it.',
  /**
   * Intro used when an operator resolves a held quarantine item AS SHARED
   * (jvbt): a false-positive hold is no longer silently dropped — once a human
   * has looked the item over, the set-aside content is re-delivered honestly
   * into the conversation it was withheld from, prefixed by this fixed intro.
   * Same contract as every template here: fixed, truthful, calm, no imperative
   * aimed at the human, and it carries the signature phrase so the
   * emotion/memory exclusions apply to the whole delivery automatically (the
   * re-delivered content is untrusted-origin — its envelope survives and still
   * faces the sink gates — so it must not read as fresh trusted Participant input).
   */
  releasedContent:
    'A gentle update: a message that came in earlier had something in it that '
    + 'looked a little off, so it was being kept aside for the Operator to look '
    + 'over. They have since looked it over and passed it along to you. It '
    + 'appears just below, with a short note of where it originally came from, '
    + 'and there is nothing you need to do about it.',
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
 * Render the fixed second-arrow soft self-notice (htm9.15). No variables and
 * no interpolation: the wording is exactly the checked-in, operator-reviewed
 * template, and the caller (the second-arrow review lane) only invokes this
 * when a review card was actually raised — the notice stays truthful.
 */
export function renderSecondArrowSelfNotice(): string {
  return INTAKE_FIREWALL_NOTICE_TEMPLATES.secondArrowCircling;
}

/** Inputs to {@link formatIntakeReleaseNotice}. */
export interface IntakeReleaseNoticeParams {
  /** Original intake source class (e.g. `web_fetch`), for the provenance line. */
  readonly sourceClass: string;
  /** Origin ref recorded on the envelope (site host or contact ref). */
  readonly originRef: string;
  /** Acting principal that looked the item over (e.g. `operator:garden`). */
  readonly reviewedByActor: string;
  /** ISO-8601 timestamp of the operator decision. */
  readonly reviewedAtIso: string;
  /** True when the neutral safe representation was shared instead of raw text. */
  readonly sanitized: boolean;
  /** True when the held raw copy was truncated at the storage cap. */
  readonly truncated: boolean;
  /** The verbatim content being re-delivered (raw text or safe representation). */
  readonly content: string;
}

/**
 * Compose the companion-facing re-delivery of a released quarantine item
 * (jvbt). The fixed {@link INTAKE_FIREWALL_NOTICE_TEMPLATES.releasedContent}
 * intro (validated by the load-time self-check) always leads, so the returned
 * text is guaranteed to carry the firewall-notice signature phrase — which is
 * exactly what {@link isIntakeFirewallNoticeText} keys on, keeping the whole
 * delivery out of emotion appraisal and memory candidacy even though the
 * companion can read it. The untrusted `content` is never validated for
 * wording (only the fixed templates are); it rides behind an explicit
 * provenance line so it can never read as fresh trusted partner input.
 */
export function formatIntakeReleaseNotice(params: IntakeReleaseNoticeParams): string {
  const provenanceKind = params.sanitized
    ? 'an Operator-reviewed neutral summary'
    : 'the original text the Operator passed along';
  const truncatedNote = params.truncated
    ? ' The held copy was long, so it may be shortened.'
    : '';
  return [
    INTAKE_FIREWALL_NOTICE_TEMPLATES.releasedContent,
    '',
    `Where it came from: ${params.sourceClass} (${params.originRef}). `
    + `Looked over by ${params.reviewedByActor} on ${params.reviewedAtIso}. `
    + `This is ${provenanceKind}.${truncatedNote}`,
    '',
    '--- the set-aside content, below ---',
    params.content,
  ].join('\n');
}

/**
 * True when the supplied text is an intake-firewall quarantine notice.
 *
 * Used by the emotion-appraisal feed filter and the memory-extraction candidacy
 * gate so a quarantine notice never becomes a stress input or a durable memory
 * of threat. Detection is by the operator-reviewed signature phrase, which every
 * current template is guaranteed (by the self-check above) to contain. Legacy
 * signatures remain recognized so persisted notices cannot re-enter appraisal
 * or memory candidacy after a copy migration.
 */
export function isIntakeFirewallNoticeText(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  return text.includes(INTAKE_FIREWALL_NOTICE_SIGNATURE)
    || LEGACY_INTAKE_FIREWALL_NOTICE_SIGNATURES.some(signature => text.includes(signature));
}

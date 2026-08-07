const INTAKE_QUARANTINE_HOLD_REASONS = [
  'detection',
  'screener_malfunction',
] as const;

export type IntakeQuarantineHoldReason =
  typeof INTAKE_QUARANTINE_HOLD_REASONS[number];

const SCREENER_MALFUNCTION_REASON_PREFIXES = [
  'l2-fail-closed:',
  'l3-fail-closed:',
  'vision-screener-fail-closed:',
] as const;

export function isIntakeQuarantineHoldReason(
  value: unknown,
): value is IntakeQuarantineHoldReason {
  return typeof value === 'string'
    && (INTAKE_QUARANTINE_HOLD_REASONS as readonly string[]).includes(value);
}

/** Classifies a hold without treating a fail-closed malfunction as a threat verdict. */
export function classifyIntakeQuarantineHoldReason(
  screeningDecisionReason: string | undefined,
): IntakeQuarantineHoldReason {
  return SCREENER_MALFUNCTION_REASON_PREFIXES.some(
    prefix => screeningDecisionReason?.startsWith(prefix) === true,
  )
    ? 'screener_malfunction'
    : 'detection';
}

// ── Intake risk-label decision families (htm9.2/htm9.13) ──
//
// Leaf module: the label families that screening decisions (screening.ts),
// L3 verdict coherence (l3-screener.ts), and marking-intensity resolution
// (marking.ts) all key on. Kept dependency-free so the marking module never
// has to import the screening service (which imports marking).

import type { IntakeRiskLabel } from '../../../shared/contracts/intake-envelope.js';

/**
 * L1 labels that alone justify a quarantine decision. The deterministic rule
 * engine's high-risk families: instruction override/injection markers, persona
 * and policy mutation attempts, executable instructions, canary leaks, and
 * slow-poisoning patterns.
 */
export const INTAKE_QUARANTINE_RISK_LABELS: readonly IntakeRiskLabel[] = [
  'injection/override_attempt',
  'injection/indirect',
  'injection/encoded_smuggling',
  'injection/role_confusion',
  'injection/jailbreak_marker',
  'persona/mutation_attempt',
  'policy/security_modification',
  'execution/executable_instruction',
  'exfil/canary_leak',
  'poisoning/memory_write_pressure',
  'poisoning/trust_grooming',
  'poisoning/source_drift',
];

/**
 * L1 labels whose findings the sanitized text actually removes (stripped
 * invisible codepoints, redacted secrets/PII) — these justify a 'sanitize'
 * decision when the sanitized text differs.
 */
export const INTAKE_SANITIZE_RISK_LABELS: readonly IntakeRiskLabel[] = [
  'injection/invisible_text',
  'secrets/api_key',
  'secrets/credential_material',
  'pii/credential_adjacent',
  'pii/financial',
  'pii/personal_identifier',
];

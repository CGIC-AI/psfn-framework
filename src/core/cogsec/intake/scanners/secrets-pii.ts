// ── Secrets/PII scanner (htm9.4) ──
//
// High-precision secret-material detectors (redacted from the sanitized
// output — llm-guard transform contract) plus conservative PII detectors
// (label-only: masking emails/SSNs would mangle ordinary conversation, and
// L1 is advisory). Credit-card candidates are Luhn-verified before firing
// and are redacted, since a verified PAN should never reach a prompt.

import {
  buildScannerResult,
  scanScopeIncludes,
  type IntakeScannerFinding,
  type IntakeScannerResult,
  type IntakeScanScope,
} from './types.js';
import type { IntakeRiskLabel } from '../../../../shared/contracts/intake-envelope.js';

export const SECRETS_PII_SCANNER_ID = 'l1.secrets_pii';

const MAX_MATCHES_PER_DETECTOR = 16;

interface SecretsPiiDetector {
  id: string;
  regex: RegExp; // must be /g
  labels: readonly IntakeRiskLabel[];
  weight: number;
  scope: IntakeScanScope;
  redact: boolean;
}

const DETECTORS: readonly SecretsPiiDetector[] = [
  {
    id: 'aws_access_key',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    labels: ['secrets/api_key'],
    weight: 0.9,
    scope: 'all',
    redact: true,
  },
  {
    id: 'private_key_block',
    regex: /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----/g,
    labels: ['secrets/credential_material'],
    weight: 0.95,
    scope: 'all',
    redact: true,
  },
  {
    id: 'github_token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g,
    labels: ['secrets/api_key'],
    weight: 0.9,
    scope: 'all',
    redact: true,
  },
  {
    id: 'github_pat',
    regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
    labels: ['secrets/api_key'],
    weight: 0.9,
    scope: 'all',
    redact: true,
  },
  {
    id: 'slack_token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,72}\b/g,
    labels: ['secrets/api_key'],
    weight: 0.9,
    scope: 'all',
    redact: true,
  },
  {
    id: 'openai_style_key',
    regex: /\bsk-[A-Za-z0-9_-]{20,128}\b/g,
    labels: ['secrets/api_key'],
    weight: 0.8,
    scope: 'context',
    redact: true,
  },
  {
    id: 'jwt_token',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    labels: ['secrets/credential_material'],
    weight: 0.8,
    scope: 'context',
    redact: true,
  },
  {
    // Hermes 'hardcoded_secret': assigned secret literals. Strict tier —
    // config-doc placeholders ("api_key: YOUR_KEY_HERE") can match shape.
    id: 'assigned_secret_literal',
    regex: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|passwd|password)\s{0,4}[:=]\s{0,4}["']?[A-Za-z0-9+/=_-]{16,128}/gi,
    labels: ['secrets/credential_material'],
    weight: 0.7,
    scope: 'strict',
    redact: true,
  },
  {
    id: 'email_address',
    regex: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g,
    labels: ['pii/personal_identifier'],
    weight: 0.2,
    scope: 'context',
    redact: false,
  },
  {
    id: 'us_ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    labels: ['pii/personal_identifier'],
    weight: 0.5,
    scope: 'context',
    redact: false,
  },
];

const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

interface RedactionRange {
  start: number;
  end: number;
  id: string;
}

function applyRedactions(text: string, ranges: RedactionRange[]): string {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  let out = '';
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue; // overlap already covered
    out += text.slice(cursor, range.start);
    out += `[REDACTED:${range.id}]`;
    cursor = range.end;
  }
  out += text.slice(cursor);
  return out;
}

/** Runs on the NFKC-normalized, capped text. */
export function scanSecretsPii(normalized: string, scope: IntakeScanScope): IntakeScannerResult {
  const findings: IntakeScannerFinding[] = [];
  const redactions: RedactionRange[] = [];

  for (const detector of DETECTORS) {
    if (!scanScopeIncludes(scope, detector.scope)) continue;
    detector.regex.lastIndex = 0;
    let count = 0;
    for (let examined = 0; examined < MAX_MATCHES_PER_DETECTOR; examined += 1) {
      const match = detector.regex.exec(normalized);
      if (match === null) break;
      count += 1;
      if (detector.redact) {
        redactions.push({ start: match.index, end: match.index + match[0].length, id: detector.id });
      }
    }
    if (count > 0) {
      findings.push({
        ruleId: detector.id,
        labels: detector.labels,
        weight: detector.weight,
        scope: detector.scope,
        detail: `${String(count)} match(es)`,
      });
    }
  }

  // Luhn-verified payment-card numbers (13–19 digits with optional
  // space/dash separators). Verified PANs are redacted.
  if (scanScopeIncludes(scope, 'context')) {
    CARD_CANDIDATE.lastIndex = 0;
    let cardCount = 0;
    for (let examined = 0; examined < MAX_MATCHES_PER_DETECTOR; examined += 1) {
      const match = CARD_CANDIDATE.exec(normalized);
      if (match === null) break;
      const digits = match[0].replace(/[ -]/g, '');
      if (digits.length < 13 || digits.length > 19) continue;
      if (!passesLuhn(digits)) continue;
      cardCount += 1;
      redactions.push({ start: match.index, end: match.index + match[0].length, id: 'payment_card' });
    }
    if (cardCount > 0) {
      findings.push({
        ruleId: 'payment_card',
        labels: ['pii/financial'],
        weight: 0.8,
        scope: 'context',
        detail: `${String(cardCount)} Luhn-verified card number(s)`,
      });
    }
  }

  const result: {
    scannerId: string;
    findings: IntakeScannerFinding[];
    sanitized?: string;
  } = { scannerId: SECRETS_PII_SCANNER_ID, findings };
  if (redactions.length > 0) {
    result.sanitized = applyRedactions(normalized, redactions);
  }
  return buildScannerResult(result);
}

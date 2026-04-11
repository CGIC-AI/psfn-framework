// ── Memory Abstraction Transform ──
// Converts specific/sensitive event memories into generalized lessons.

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_PATTERN = /\bhttps?:\/\/\S+\b/gi;
const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/g;
const HANDLE_PATTERN = /@[a-z0-9_]{2,32}\b/gi;
const ID_PATTERN = /\b(?:id|uuid|ticket|order|ssn|acct|account)\s*[:#]?\s*[a-z0-9-]{4,}\b/gi;
const DATE_PATTERN = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/g;
const TIME_PATTERN = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi;
const DAY_PATTERN = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/g;
const LONG_NUMBER_PATTERN = /\b\d{3,}\b/g;
const SINGLE_INITIAL_PATTERN = /\b[A-Z]\b/g;
const PROPER_NAME_PATTERN = /\b[A-Z][a-z]{2,}\b/g;

const MEDICATION_MISS_PATTERN = /\b(missed|forgot|skipped|late)\b[\s\S]{0,48}\b(med|meds|medication|dose|pill|pills)\b/i;
const SCHEDULE_MISS_PATTERN = /\b(missed|forgot|late|skipped)\b[\s\S]{0,48}\b(meeting|appointment|deadline|call)\b/i;
const HIGH_WORKLOAD_PATTERN = /\b(workload|work|shift|deadline|sprint|busy|overload|overwhelmed)\b/i;
const RELATIONSHIP_CONTEXT_PATTERN = /\b(partner|spouse|wife|husband|boyfriend|girlfriend)\b/i;

export interface MemoryAbstractionResult {
  text: string;
  redactedSignals: string[];
}

function recordReplacement(
  input: string,
  pattern: RegExp,
  replacement: string,
  signal: string,
  redactedSignals: string[],
): string {
  const next = input.replace(pattern, replacement);
  if (next !== input) redactedSignals.push(signal);
  return next;
}

function inferSubject(text: string): 'Partner' | 'Someone' {
  if (RELATIONSHIP_CONTEXT_PATTERN.test(text)) {
    return 'Partner';
  }
  if (/^\s*[A-Z]\b/.test(text)) {
    return 'Partner';
  }
  if (/\b(my|our)\b/i.test(text)) {
    return 'Partner';
  }
  return 'Someone';
}

function normalizeSentence(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const withoutTrailing = compact.replace(/[.!?]+$/g, '');
  const withCapital = withoutTrailing.charAt(0).toUpperCase() + withoutTrailing.slice(1);
  return `${withCapital}.`;
}

function fallbackLesson(subject: string, redacted: string): string {
  const normalized = redacted
    .replace(/\[(?:private|time|date|id|count|name|link|handle)\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length < 18) {
    return `${subject} benefits from consistent support and proactive check-ins.`;
  }

  return normalizeSentence(`${subject} benefits from support when ${normalized.toLowerCase()}`);
}

export function abstractMemoryText(sourceText: string): MemoryAbstractionResult {
  const normalizedSource = sourceText.replace(/\s+/g, ' ').trim();
  const subject = inferSubject(normalizedSource);
  const redactedSignals: string[] = [];

  if (!normalizedSource) {
    return {
      text: `${subject} benefits from consistent support and proactive check-ins.`,
      redactedSignals,
    };
  }

  const lowered = normalizedSource.toLowerCase();
  if (MEDICATION_MISS_PATTERN.test(lowered)) {
    const highWorkloadSuffix = HIGH_WORKLOAD_PATTERN.test(lowered)
      ? ' during high workload periods'
      : '';
    return {
      text: `${subject} benefits from medication reminders${highWorkloadSuffix}.`,
      redactedSignals: ['medication_pattern'],
    };
  }

  if (SCHEDULE_MISS_PATTERN.test(lowered)) {
    return {
      text: `${subject} benefits from proactive schedule reminders during busy periods.`,
      redactedSignals: ['schedule_pattern'],
    };
  }

  let redacted = normalizedSource;
  redacted = recordReplacement(redacted, EMAIL_PATTERN, '[private]', 'email', redactedSignals);
  redacted = recordReplacement(redacted, URL_PATTERN, '[link]', 'url', redactedSignals);
  redacted = recordReplacement(redacted, PHONE_PATTERN, '[private]', 'phone', redactedSignals);
  redacted = recordReplacement(redacted, HANDLE_PATTERN, '[handle]', 'handle', redactedSignals);
  redacted = recordReplacement(redacted, ID_PATTERN, '[id]', 'identifier', redactedSignals);
  redacted = recordReplacement(redacted, DATE_PATTERN, '[date]', 'date', redactedSignals);
  redacted = recordReplacement(redacted, TIME_PATTERN, '[time]', 'time', redactedSignals);
  redacted = recordReplacement(redacted, DAY_PATTERN, '[date]', 'weekday', redactedSignals);
  redacted = recordReplacement(redacted, YEAR_PATTERN, '[date]', 'year', redactedSignals);
  redacted = recordReplacement(redacted, LONG_NUMBER_PATTERN, '[count]', 'number', redactedSignals);
  redacted = recordReplacement(redacted, SINGLE_INITIAL_PATTERN, '[name]', 'initial', redactedSignals);
  redacted = recordReplacement(redacted, PROPER_NAME_PATTERN, '[name]', 'proper_name', redactedSignals);

  return {
    text: fallbackLesson(subject, redacted),
    redactedSignals,
  };
}

import { isRecord } from '../../shared/utils/types.js';

/**
 * Versioned, schema-validated presentation profile for the retrieval formatting
 * layer (0236). This governs HOW retrieved memory is rendered
 * into the companion-facing prompt block — section ordering, heading wording,
 * valence markers, recency-band labels, the always-on episode cap, per-type
 * display caps, and optional withheld-memory wording overrides. It deliberately
 * does NOT touch retrieval SELECTION (which memories are chosen) or privacy
 * logic — those remain owned by `memoryRetrievalPolicy` and the access filters.
 *
 * Operator stance: presentation of memory outranks the personality card, and
 * multi-companion differences (emotion-heavy vs procedural-heavy) must be
 * tunable without editing retrieval code. Bump PRESENTATION_PROFILE_VERSION when
 * the default rendering intentionally changes so goldens are re-recorded on
 * purpose, never by accident.
 */
export const PRESENTATION_PROFILE_VERSION = 1;

/**
 * Top-level prompt sections of the retrieved-memory block, in canonical default
 * order. `sectionOrder` must be an exact permutation of this list. The ids match
 * the structural section ids used elsewhere (goldens, cogsec) and never change
 * with heading wording.
 */
export const MEMORY_PRESENTATION_SECTIONS = [
  'core_profile',
  'relationship_context',
  'emotional_continuity_snapshot',
  'cross_session_emotional_continuity',
  'memory_context_note',
  'episodic_landmark_chains',
  'relevant_memories',
] as const;

export type MemoryPresentationSection = (typeof MEMORY_PRESENTATION_SECTIONS)[number];

export interface MemoryPresentationHeadings {
  /** Boundary/refusal memory section heading. */
  boundary: string;
  /** Canonical "relevant memories" section heading. */
  relevant: string;
  /** Related-people (in social context) attributed section heading. */
  socialContext: string;
  /** Separate-people attributed section heading. */
  separatePeople: string;
  /** Cross-session emotional continuity section heading. */
  emotionalContinuity: string;
  /** Episodic landmark chains section heading. */
  episodicLandmarks: string;
}

export interface MemoryPresentationValence {
  /** A memory line gets the positive marker when valence is strictly above this. */
  positiveThreshold: number;
  /** A memory line gets the negative marker when valence is strictly below this. */
  negativeThreshold: number;
  /** Marker appended for positive-valence memory lines. */
  positiveMarker: string;
  /** Marker appended for negative-valence memory lines. */
  negativeMarker: string;
  /** Emotional-continuity block positive marker threshold (inclusive). */
  continuityPositiveThreshold: number;
  /** Emotional-continuity block negative marker threshold (inclusive). */
  continuityNegativeThreshold: number;
}

export interface MemoryPresentationRecencyLabels {
  today: string;
  yesterday: string;
  thisWeek: string;
  /** Template for a single week ago; `{n}` is replaced with the week count (1). */
  weekAgo: string;
  /** Template for multiple weeks ago; `{n}` is replaced with the week count. */
  weeksAgo: string;
  /** Template for months ago; `{n}` is replaced with the month count. */
  monthsAgo: string;
  /** Template for years ago; `{n}` is replaced with the year count. */
  yearsAgo: string;
}

export interface MemoryPresentationDisplayCaps {
  /** Max emotional-type memory lines rendered per turn, or null for uncapped. */
  emotional: number | null;
  /** Max procedural-type memory lines rendered per turn, or null for uncapped. */
  procedural: number | null;
}

/**
 * Optional per-companion overrides for the withheld-memory ("memory context
 * note") wording. When a field is null the runtime falls back to the
 * system-owned language layer default for that template. Override strings use
 * the same `{{token}}` substitution as the system-language templates.
 */
export interface MemoryPresentationWithheldWording {
  header: string | null;
  /** Variables: {{total_count}}, {{memory_noun}}. */
  withheldCount: string | null;
  /** Variables: {{detail_line}}. */
  reasons: string | null;
  /** Variables: {{relevance_line}}. */
  relevance: string | null;
  safeNextActions: string | null;
}

export interface MemoryPresentationProfile {
  version: number;
  sectionOrder: MemoryPresentationSection[];
  headings: MemoryPresentationHeadings;
  valence: MemoryPresentationValence;
  recencyLabels: MemoryPresentationRecencyLabels;
  /** Always-on episodic landmark block: max total episodes across all chains. */
  episodeCap: number;
  displayCaps: MemoryPresentationDisplayCaps;
  withheldWording: MemoryPresentationWithheldWording;
}

function freezeMemoryPresentationProfile(
  profile: MemoryPresentationProfile,
): MemoryPresentationProfile {
  Object.freeze(profile.sectionOrder);
  Object.freeze(profile.headings);
  Object.freeze(profile.valence);
  Object.freeze(profile.recencyLabels);
  Object.freeze(profile.displayCaps);
  Object.freeze(profile.withheldWording);
  return Object.freeze(profile);
}

const DEFAULT_PROFILE: MemoryPresentationProfile = freezeMemoryPresentationProfile({
  version: PRESENTATION_PROFILE_VERSION,
  sectionOrder: [...MEMORY_PRESENTATION_SECTIONS],
  headings: {
    boundary: 'Active safety boundaries from prior refusals:',
    relevant: 'Relevant memories for this person:',
    socialContext: 'Relevant memories about other people in their social context:',
    separatePeople: 'Relevant memories about other separate people:',
    emotionalContinuity: 'Cross-session emotional continuity:',
    episodicLandmarks: 'Episodes from your shared history related to this conversation:',
  },
  valence: {
    positiveThreshold: 0.3,
    negativeThreshold: -0.3,
    positiveMarker: ' (+)',
    negativeMarker: ' (-)',
    continuityPositiveThreshold: 0.25,
    continuityNegativeThreshold: -0.25,
  },
  recencyLabels: {
    today: 'today',
    yesterday: 'yesterday',
    thisWeek: 'this week',
    weekAgo: '{n} week ago',
    weeksAgo: '{n} weeks ago',
    monthsAgo: '{n} months ago',
    yearsAgo: '{n} years ago',
  },
  episodeCap: 5,
  displayCaps: {
    emotional: null,
    procedural: null,
  },
  withheldWording: {
    header: null,
    withheldCount: null,
    reasons: null,
    relevance: null,
    safeNextActions: null,
  },
});

export function createDefaultMemoryPresentationProfile(): MemoryPresentationProfile {
  return structuredClone(DEFAULT_PROFILE);
}

export function resolveMemoryPresentationProfile(
  profile: MemoryPresentationProfile | undefined,
): MemoryPresentationProfile {
  return profile ?? DEFAULT_PROFILE;
}

export function cloneMemoryPresentationProfile(
  profile: MemoryPresentationProfile,
): MemoryPresentationProfile {
  return structuredClone(profile);
}

// ---------------------------------------------------------------------------
// Fail-closed normalization. Malformed presentation config is a loud error, not
// a silent default: a missing/unknown key, wrong type, out-of-range number, or a
// sectionOrder that is not an exact permutation all throw.
// ---------------------------------------------------------------------------

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  fieldPath: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter(key => !(key in value));
  const unknown = Object.keys(value).filter(key => !expected.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
      ...(unknown.length > 0 ? [`unknown ${unknown.join(', ')}`] : []),
    ].join('; ');
    throw new Error(`Invalid settings at ${fieldPath}: ${details}`);
  }
}

function requireRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }
  return value;
}

function requireString(
  value: unknown,
  fieldPath: string,
  { minLength, maxLength }: { minLength: number; maxLength: number },
): string {
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    throw new Error(
      `Invalid settings at ${fieldPath}: expected string of length ${minLength}-${maxLength}`,
    );
  }
  return value;
}

function requireFiniteNumber(
  value: unknown,
  fieldPath: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(
      `Invalid settings at ${fieldPath}: expected finite number between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function requireInteger(
  value: unknown,
  fieldPath: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = requireFiniteNumber(value, fieldPath, minimum, maximum);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected integer`);
  }
  return parsed;
}

function requireNullableInteger(
  value: unknown,
  fieldPath: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null) return null;
  return requireInteger(value, fieldPath, minimum, maximum);
}

function requireNullableString(
  value: unknown,
  fieldPath: string,
  bounds: { minLength: number; maxLength: number },
): string | null {
  if (value === null) return null;
  return requireString(value, fieldPath, bounds);
}

function normalizeSectionOrder(value: unknown, fieldPath: string): MemoryPresentationSection[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected array`);
  }
  const allowed = new Set<string>(MEMORY_PRESENTATION_SECTIONS);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.has(entry)) {
      throw new Error(
        `Invalid settings at ${fieldPath}: unknown section "${String(entry)}"`,
      );
    }
    if (seen.has(entry)) {
      throw new Error(`Invalid settings at ${fieldPath}: duplicate section "${entry}"`);
    }
    seen.add(entry);
  }
  const missing = MEMORY_PRESENTATION_SECTIONS.filter(section => !seen.has(section));
  if (missing.length > 0) {
    throw new Error(
      `Invalid settings at ${fieldPath}: missing sections ${missing.join(', ')}`,
    );
  }
  return value as MemoryPresentationSection[];
}

function normalizeHeadings(value: unknown, fieldPath: string): MemoryPresentationHeadings {
  const record = requireRecord(value, fieldPath);
  const keys: Array<keyof MemoryPresentationHeadings> = [
    'boundary',
    'relevant',
    'socialContext',
    'separatePeople',
    'emotionalContinuity',
    'episodicLandmarks',
  ];
  assertExactKeys(record, keys, fieldPath);
  const bounds = { minLength: 1, maxLength: 240 };
  return {
    boundary: requireString(record.boundary, `${fieldPath}.boundary`, bounds),
    relevant: requireString(record.relevant, `${fieldPath}.relevant`, bounds),
    socialContext: requireString(record.socialContext, `${fieldPath}.socialContext`, bounds),
    separatePeople: requireString(record.separatePeople, `${fieldPath}.separatePeople`, bounds),
    emotionalContinuity: requireString(
      record.emotionalContinuity,
      `${fieldPath}.emotionalContinuity`,
      bounds,
    ),
    episodicLandmarks: requireString(
      record.episodicLandmarks,
      `${fieldPath}.episodicLandmarks`,
      bounds,
    ),
  };
}

function normalizeValence(value: unknown, fieldPath: string): MemoryPresentationValence {
  const record = requireRecord(value, fieldPath);
  assertExactKeys(
    record,
    [
      'positiveThreshold',
      'negativeThreshold',
      'positiveMarker',
      'negativeMarker',
      'continuityPositiveThreshold',
      'continuityNegativeThreshold',
    ],
    fieldPath,
  );
  const markerBounds = { minLength: 0, maxLength: 16 };
  return {
    positiveThreshold: requireFiniteNumber(
      record.positiveThreshold,
      `${fieldPath}.positiveThreshold`,
      0,
      1,
    ),
    negativeThreshold: requireFiniteNumber(
      record.negativeThreshold,
      `${fieldPath}.negativeThreshold`,
      -1,
      0,
    ),
    positiveMarker: requireString(record.positiveMarker, `${fieldPath}.positiveMarker`, markerBounds),
    negativeMarker: requireString(record.negativeMarker, `${fieldPath}.negativeMarker`, markerBounds),
    continuityPositiveThreshold: requireFiniteNumber(
      record.continuityPositiveThreshold,
      `${fieldPath}.continuityPositiveThreshold`,
      0,
      1,
    ),
    continuityNegativeThreshold: requireFiniteNumber(
      record.continuityNegativeThreshold,
      `${fieldPath}.continuityNegativeThreshold`,
      -1,
      0,
    ),
  };
}

function normalizeRecencyLabels(
  value: unknown,
  fieldPath: string,
): MemoryPresentationRecencyLabels {
  const record = requireRecord(value, fieldPath);
  const keys: Array<keyof MemoryPresentationRecencyLabels> = [
    'today',
    'yesterday',
    'thisWeek',
    'weekAgo',
    'weeksAgo',
    'monthsAgo',
    'yearsAgo',
  ];
  assertExactKeys(record, keys, fieldPath);
  const bounds = { minLength: 1, maxLength: 64 };
  return {
    today: requireString(record.today, `${fieldPath}.today`, bounds),
    yesterday: requireString(record.yesterday, `${fieldPath}.yesterday`, bounds),
    thisWeek: requireString(record.thisWeek, `${fieldPath}.thisWeek`, bounds),
    weekAgo: requireString(record.weekAgo, `${fieldPath}.weekAgo`, bounds),
    weeksAgo: requireString(record.weeksAgo, `${fieldPath}.weeksAgo`, bounds),
    monthsAgo: requireString(record.monthsAgo, `${fieldPath}.monthsAgo`, bounds),
    yearsAgo: requireString(record.yearsAgo, `${fieldPath}.yearsAgo`, bounds),
  };
}

function normalizeDisplayCaps(
  value: unknown,
  fieldPath: string,
): MemoryPresentationDisplayCaps {
  const record = requireRecord(value, fieldPath);
  assertExactKeys(record, ['emotional', 'procedural'], fieldPath);
  return {
    emotional: requireNullableInteger(record.emotional, `${fieldPath}.emotional`, 1, 1_000),
    procedural: requireNullableInteger(record.procedural, `${fieldPath}.procedural`, 1, 1_000),
  };
}

function normalizeWithheldWording(
  value: unknown,
  fieldPath: string,
): MemoryPresentationWithheldWording {
  const record = requireRecord(value, fieldPath);
  const keys: Array<keyof MemoryPresentationWithheldWording> = [
    'header',
    'withheldCount',
    'reasons',
    'relevance',
    'safeNextActions',
  ];
  assertExactKeys(record, keys, fieldPath);
  const bounds = { minLength: 1, maxLength: 600 };
  return {
    header: requireNullableString(record.header, `${fieldPath}.header`, bounds),
    withheldCount: requireNullableString(record.withheldCount, `${fieldPath}.withheldCount`, bounds),
    reasons: requireNullableString(record.reasons, `${fieldPath}.reasons`, bounds),
    relevance: requireNullableString(record.relevance, `${fieldPath}.relevance`, bounds),
    safeNextActions: requireNullableString(
      record.safeNextActions,
      `${fieldPath}.safeNextActions`,
      bounds,
    ),
  };
}

export function normalizeMemoryPresentationProfile(
  value: unknown,
  fieldPath = 'memoryPresentationProfile',
): MemoryPresentationProfile {
  const record = requireRecord(value, fieldPath);
  assertExactKeys(
    record,
    [
      'version',
      'sectionOrder',
      'headings',
      'valence',
      'recencyLabels',
      'episodeCap',
      'displayCaps',
      'withheldWording',
    ],
    fieldPath,
  );
  const version = requireInteger(record.version, `${fieldPath}.version`, 1, 1_000_000);
  if (version !== PRESENTATION_PROFILE_VERSION) {
    throw new Error(
      `Invalid settings at ${fieldPath}.version: expected ${PRESENTATION_PROFILE_VERSION}, received ${version}`,
    );
  }
  return {
    version,
    sectionOrder: normalizeSectionOrder(record.sectionOrder, `${fieldPath}.sectionOrder`),
    headings: normalizeHeadings(record.headings, `${fieldPath}.headings`),
    valence: normalizeValence(record.valence, `${fieldPath}.valence`),
    recencyLabels: normalizeRecencyLabels(record.recencyLabels, `${fieldPath}.recencyLabels`),
    episodeCap: requireInteger(record.episodeCap, `${fieldPath}.episodeCap`, 1, 100),
    displayCaps: normalizeDisplayCaps(record.displayCaps, `${fieldPath}.displayCaps`),
    withheldWording: normalizeWithheldWording(record.withheldWording, `${fieldPath}.withheldWording`),
  };
}

/**
 * Substitute `{n}` in a recency-band label template with a count. Kept separate
 * so both the formatter and its tests share one substitution rule.
 */
export function formatRecencyLabelTemplate(template: string, count: number): string {
  return template.split('{n}').join(String(count));
}

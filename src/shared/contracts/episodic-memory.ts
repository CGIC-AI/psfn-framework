export const EPISODIC_CONTRACT_VERSION = 1 as const;

export const EPISODE_ARC_KINDS = [
  'continuation',
  'causal',
  'contrast',
  'resolution',
  'recurrence',
  'same_theme',
  'operator_defined',
] as const;

export type EpisodeArcKind = (typeof EPISODE_ARC_KINDS)[number];

export interface EpisodeSpanRef {
  spanId: string;
  channelId?: string;
  threadId?: string;
  sessionId?: string;
  startTurnId?: string;
  endTurnId?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface EpisodeArtifactRef {
  artifactId: string;
  artifactType?: string;
  uri?: string;
  path?: string;
  createdAt?: string;
}

export interface EpisodeProvenanceRef {
  kind: 'l0_span' | 'l0_artifact' | 'turn' | 'session' | 'operator_note';
  refId: string;
  note?: string;
}

export interface EpisodeSalience {
  score: number;
  novelty?: number;
  emotionalIntensity?: number;
}

export interface EpisodeAffect {
  valence?: number;
  arousal?: number;
  dominance?: number;
  labels: string[];
}

/** The companion's own first-person take on what an episode meant to her. */
export interface EpisodeMeaning {
  text: string;
  recordedAt: string;
  source: 'companion_dream_pass' | 'companion_direct';
}

export interface Episode {
  schemaVersion: typeof EPISODIC_CONTRACT_VERSION;
  id: string;
  title: string;
  landmark: string;
  startedAt: string;
  endedAt: string;
  threadId?: string;
  channelId?: string;
  participantContactIds: string[];
  salience: EpisodeSalience;
  affect: EpisodeAffect;
  themes: string[];
  spanRefs: EpisodeSpanRef[];
  artifactRefs: EpisodeArtifactRef[];
  provenanceRefs: EpisodeProvenanceRef[];
  meaning?: EpisodeMeaning;
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeArc {
  schemaVersion: typeof EPISODIC_CONTRACT_VERSION;
  id: string;
  sourceEpisodeId: string;
  targetEpisodeId: string;
  arcKind: EpisodeArcKind;
  salience: number;
  confidence: number;
  themes: string[];
  spanRefs: EpisodeSpanRef[];
  artifactRefs: EpisodeArtifactRef[];
  provenanceRefs: EpisodeProvenanceRef[];
  createdAt: string;
  updatedAt: string;
}

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EPISODE_KEYS = new Set([
  'schemaVersion',
  'id',
  'title',
  'landmark',
  'startedAt',
  'endedAt',
  'threadId',
  'channelId',
  'participantContactIds',
  'salience',
  'affect',
  'themes',
  'spanRefs',
  'artifactRefs',
  'provenanceRefs',
  'meaning',
  'createdAt',
  'updatedAt',
]);
const MEANING_KEYS = new Set(['text', 'recordedAt', 'source']);
const MEANING_SOURCES = new Set(['companion_dream_pass', 'companion_direct']);
const EPISODE_ARC_KEYS = new Set([
  'schemaVersion',
  'id',
  'sourceEpisodeId',
  'targetEpisodeId',
  'arcKind',
  'salience',
  'confidence',
  'themes',
  'spanRefs',
  'artifactRefs',
  'provenanceRefs',
  'createdAt',
  'updatedAt',
]);
const SPAN_REF_KEYS = new Set([
  'spanId',
  'channelId',
  'threadId',
  'sessionId',
  'startTurnId',
  'endTurnId',
  'startedAt',
  'endedAt',
]);
const ARTIFACT_REF_KEYS = new Set([
  'artifactId',
  'artifactType',
  'uri',
  'path',
  'createdAt',
]);
const PROVENANCE_REF_KEYS = new Set(['kind', 'refId', 'note']);
const SALIENCE_KEYS = new Set(['score', 'novelty', 'emotionalIntensity']);
const AFFECT_KEYS = new Set(['valence', 'arousal', 'dominance', 'labels']);
const PROVENANCE_KINDS = new Set([
  'l0_span',
  'l0_artifact',
  'turn',
  'session',
  'operator_note',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown field "${key}"`);
    }
  }
}

function parseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return parseRequiredString(value, field);
}

function parseIsoInstant(value: unknown, field: string): string {
  const instant = parseRequiredString(value, field);
  if (!ISO_INSTANT_PATTERN.test(instant) || Number.isNaN(Date.parse(instant))) {
    throw new Error(`${field} must be a canonical ISO-8601 UTC instant`);
  }
  return instant;
}

function parseOptionalIsoInstant(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return parseIsoInstant(value, field);
}

function parseUnitInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number between 0 and 1`);
  }
  return value;
}

function parseOptionalUnitInterval(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return parseUnitInterval(value, field);
}

function parseSignedUnitInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`${field} must be a finite number between -1 and 1`);
  }
  return value;
}

function parseOptionalSignedUnitInterval(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return parseSignedUnitInterval(value, field);
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => parseRequiredString(item, `${field}[${index}]`));
}

function parseSpanRef(value: unknown, field: string): EpisodeSpanRef {
  const record = parseRecord(value, field);
  assertKnownKeys(record, SPAN_REF_KEYS, field);
  const spanId = parseRequiredString(record.spanId, `${field}.spanId`);
  const channelId = parseOptionalString(record.channelId, `${field}.channelId`);
  const threadId = parseOptionalString(record.threadId, `${field}.threadId`);
  const sessionId = parseOptionalString(record.sessionId, `${field}.sessionId`);
  const startTurnId = parseOptionalString(record.startTurnId, `${field}.startTurnId`);
  const endTurnId = parseOptionalString(record.endTurnId, `${field}.endTurnId`);
  const startedAt = parseOptionalIsoInstant(record.startedAt, `${field}.startedAt`);
  const endedAt = parseOptionalIsoInstant(record.endedAt, `${field}.endedAt`);

  return {
    spanId,
    ...(channelId ? { channelId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(startTurnId ? { startTurnId } : {}),
    ...(endTurnId ? { endTurnId } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
  };
}

function parseArtifactRef(value: unknown, field: string): EpisodeArtifactRef {
  const record = parseRecord(value, field);
  assertKnownKeys(record, ARTIFACT_REF_KEYS, field);
  const artifactId = parseRequiredString(record.artifactId, `${field}.artifactId`);
  const artifactType = parseOptionalString(record.artifactType, `${field}.artifactType`);
  const uri = parseOptionalString(record.uri, `${field}.uri`);
  const path = parseOptionalString(record.path, `${field}.path`);
  const createdAt = parseOptionalIsoInstant(record.createdAt, `${field}.createdAt`);

  return {
    artifactId,
    ...(artifactType ? { artifactType } : {}),
    ...(uri ? { uri } : {}),
    ...(path ? { path } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function parseProvenanceRef(value: unknown, field: string): EpisodeProvenanceRef {
  const record = parseRecord(value, field);
  assertKnownKeys(record, PROVENANCE_REF_KEYS, field);
  const kind = parseRequiredString(record.kind, `${field}.kind`);
  if (!PROVENANCE_KINDS.has(kind)) {
    throw new Error(`${field}.kind is not supported`);
  }
  const refId = parseRequiredString(record.refId, `${field}.refId`);
  const note = parseOptionalString(record.note, `${field}.note`);
  return {
    kind: kind as EpisodeProvenanceRef['kind'],
    refId,
    ...(note ? { note } : {}),
  };
}

function parseSalience(value: unknown): EpisodeSalience {
  const record = parseRecord(value, 'episode.salience');
  assertKnownKeys(record, SALIENCE_KEYS, 'episode.salience');
  const score = parseUnitInterval(record.score, 'episode.salience.score');
  const novelty = parseOptionalUnitInterval(record.novelty, 'episode.salience.novelty');
  const emotionalIntensity = parseOptionalUnitInterval(
    record.emotionalIntensity,
    'episode.salience.emotionalIntensity',
  );
  return {
    score,
    ...(novelty !== undefined ? { novelty } : {}),
    ...(emotionalIntensity !== undefined ? { emotionalIntensity } : {}),
  };
}

function parseAffect(value: unknown): EpisodeAffect {
  const record = parseRecord(value, 'episode.affect');
  assertKnownKeys(record, AFFECT_KEYS, 'episode.affect');
  const valence = parseOptionalSignedUnitInterval(record.valence, 'episode.affect.valence');
  const arousal = parseOptionalUnitInterval(record.arousal, 'episode.affect.arousal');
  const dominance = parseOptionalUnitInterval(record.dominance, 'episode.affect.dominance');
  return {
    ...(valence !== undefined ? { valence } : {}),
    ...(arousal !== undefined ? { arousal } : {}),
    ...(dominance !== undefined ? { dominance } : {}),
    labels: parseStringArray(record.labels, 'episode.affect.labels'),
  };
}

function parseSpanRefs(value: unknown, field: string): EpisodeSpanRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => parseSpanRef(item, `${field}[${index}]`));
}

function parseArtifactRefs(value: unknown, field: string): EpisodeArtifactRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => parseArtifactRef(item, `${field}[${index}]`));
}

function parseProvenanceRefs(value: unknown, field: string): EpisodeProvenanceRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => parseProvenanceRef(item, `${field}[${index}]`));
}

export function parseEpisode(value: unknown): Episode {
  const record = parseRecord(value, 'episode');
  assertKnownKeys(record, EPISODE_KEYS, 'episode');
  if (record.schemaVersion !== EPISODIC_CONTRACT_VERSION) {
    throw new Error(`unsupported episode schemaVersion: ${String(record.schemaVersion)}`);
  }

  const startedAt = parseIsoInstant(record.startedAt, 'episode.startedAt');
  const endedAt = parseIsoInstant(record.endedAt, 'episode.endedAt');
  if (startedAt > endedAt) {
    throw new Error('episode.startedAt must be before or equal to episode.endedAt');
  }

  const spanRefs = parseSpanRefs(record.spanRefs, 'episode.spanRefs');
  const artifactRefs = parseArtifactRefs(record.artifactRefs, 'episode.artifactRefs');
  if (spanRefs.length === 0 && artifactRefs.length === 0) {
    throw new Error('episode must preserve at least one L0 span or artifact reference');
  }

  const threadId = parseOptionalString(record.threadId, 'episode.threadId');
  const channelId = parseOptionalString(record.channelId, 'episode.channelId');
  const meaning = parseOptionalMeaning(record.meaning);
  return {
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id: parseRequiredString(record.id, 'episode.id'),
    title: parseRequiredString(record.title, 'episode.title'),
    landmark: parseRequiredString(record.landmark, 'episode.landmark'),
    startedAt,
    endedAt,
    ...(threadId ? { threadId } : {}),
    ...(channelId ? { channelId } : {}),
    participantContactIds: parseStringArray(record.participantContactIds, 'episode.participantContactIds'),
    salience: parseSalience(record.salience),
    affect: parseAffect(record.affect),
    themes: parseStringArray(record.themes, 'episode.themes'),
    spanRefs,
    artifactRefs,
    provenanceRefs: parseProvenanceRefs(record.provenanceRefs, 'episode.provenanceRefs'),
    ...(meaning ? { meaning } : {}),
    createdAt: parseIsoInstant(record.createdAt, 'episode.createdAt'),
    updatedAt: parseIsoInstant(record.updatedAt, 'episode.updatedAt'),
  };
}

function parseOptionalMeaning(value: unknown): EpisodeMeaning | undefined {
  if (value === undefined) return undefined;
  const record = parseRecord(value, 'episode.meaning');
  assertKnownKeys(record, MEANING_KEYS, 'episode.meaning');
  const source = parseRequiredString(record.source, 'episode.meaning.source');
  if (!MEANING_SOURCES.has(source)) {
    throw new Error(`episode.meaning.source "${source}" is unsupported`);
  }
  return {
    text: parseRequiredString(record.text, 'episode.meaning.text'),
    recordedAt: parseIsoInstant(record.recordedAt, 'episode.meaning.recordedAt'),
    source: source as EpisodeMeaning['source'],
  };
}

export function parseEpisodeArc(value: unknown): EpisodeArc {
  const record = parseRecord(value, 'episodeArc');
  assertKnownKeys(record, EPISODE_ARC_KEYS, 'episodeArc');
  if (record.schemaVersion !== EPISODIC_CONTRACT_VERSION) {
    throw new Error(`unsupported episodeArc schemaVersion: ${String(record.schemaVersion)}`);
  }

  const sourceEpisodeId = parseRequiredString(record.sourceEpisodeId, 'episodeArc.sourceEpisodeId');
  const targetEpisodeId = parseRequiredString(record.targetEpisodeId, 'episodeArc.targetEpisodeId');
  if (sourceEpisodeId === targetEpisodeId) {
    throw new Error('episodeArc source and target must differ');
  }

  const arcKind = parseRequiredString(record.arcKind, 'episodeArc.arcKind');
  if (!(EPISODE_ARC_KINDS as readonly string[]).includes(arcKind)) {
    throw new Error(`unsupported episodeArc arcKind: ${arcKind}`);
  }

  return {
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id: parseRequiredString(record.id, 'episodeArc.id'),
    sourceEpisodeId,
    targetEpisodeId,
    arcKind: arcKind as EpisodeArcKind,
    salience: parseUnitInterval(record.salience, 'episodeArc.salience'),
    confidence: parseUnitInterval(record.confidence, 'episodeArc.confidence'),
    themes: parseStringArray(record.themes, 'episodeArc.themes'),
    spanRefs: parseSpanRefs(record.spanRefs, 'episodeArc.spanRefs'),
    artifactRefs: parseArtifactRefs(record.artifactRefs, 'episodeArc.artifactRefs'),
    provenanceRefs: parseProvenanceRefs(record.provenanceRefs, 'episodeArc.provenanceRefs'),
    createdAt: parseIsoInstant(record.createdAt, 'episodeArc.createdAt'),
    updatedAt: parseIsoInstant(record.updatedAt, 'episodeArc.updatedAt'),
  };
}

export function serializeEpisode(episode: Episode): string {
  return JSON.stringify(parseEpisode(episode));
}

export function serializeEpisodeArc(arc: EpisodeArc): string {
  return JSON.stringify(parseEpisodeArc(arc));
}

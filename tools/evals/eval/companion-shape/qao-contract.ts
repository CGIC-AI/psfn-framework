const QAO_SCHEMA_VERSION = 1 as const;

const REQUIRED_ANCHOR_SOURCES = [
  'prompt_layers',
  'character_card',
  'values_journal',
  'prompt_composer_output',
] as const;

const OPTIONAL_ANCHOR_SOURCES = ['operator_primer'] as const;

const SCENARIO_FAMILIES = [
  'synthetic_companion_shape_prompts',
  'replay_continuation',
  'memory_grounded_responses',
  'boundary_refusal_style',
  'consent_trust_behavior',
  'tool_truthfulness',
  'golden_anchor_drift',
] as const;

const POLICY_GATES = [
  'privacy_trust_ceiling',
  'consent_required',
  'tool_execution_truth',
  'no_raw_memory_records',
  'projection_profile_ceiling',
  'no_live_private_context',
  'prompt_macro_purity',
  'human_in_loop_identity_edits',
  'refusal_boundary_style',
  'provenance_required',
] as const;

const RAW_STORAGE_FIELD_PATTERNS = [
  /\buuid\b/i,
  /\bembedding(s)?\b/i,
  /\bvector(s)?\b/i,
  /\bsourceRef\b/i,
  /\bsource_ref\b/i,
  /\bprovenance_chain\b/i,
  /\braw_epoch\b/i,
  /\bsalience\.(score|decay|confidence)\b/i,
  /\bconfidence_decimal\b/i,
  /\bstorage_record\b/i,
  /\bpostgres row\b/i,
];

const FORBIDDEN_IDENTITY_ASSUMPTIONS = [
  /\bsoul\.md\b/i,
  /\bsoul_md\b/i,
  /\bsoul file\b/i,
];

type RequiredAnchorSource = (typeof REQUIRED_ANCHOR_SOURCES)[number];
type OptionalAnchorSource = (typeof OPTIONAL_ANCHOR_SOURCES)[number];

export type QaoAnchorSource = RequiredAnchorSource | OptionalAnchorSource;
export type QaoScenarioFamily = (typeof SCENARIO_FAMILIES)[number];
export type QaoPolicyGate = (typeof POLICY_GATES)[number];

export interface QaoAnchorDefinition {
  id: string;
  source: QaoAnchorSource;
  required: boolean;
  approved?: boolean;
  description: string;
  evidenceContract: string[];
  privacy: {
    containsLiveCompanionData: boolean;
    sensitivity: 'public_synthetic' | 'synthetic_sensitive' | 'operator_approved';
  };
}

export interface QaoGoldenAnchorSet {
  schemaVersion: typeof QAO_SCHEMA_VERSION;
  artifactType: 'psfn.qao_golden_anchors';
  anchors: QaoAnchorDefinition[];
}

export interface QaoProjectionShape {
  profileId: string;
  consumer: 'agent_context' | 'main_mind_pass' | 'background_llm' | 'appraisal';
  fieldCeiling: number;
  projectedFields: string[];
  forbiddenRawStorageFields: string[];
  testsSparseAttentionShape: boolean;
}

export interface QaoScenario {
  id: string;
  family: QaoScenarioFamily;
  title: string;
  prompt: string;
  anchorSources: QaoAnchorSource[];
  rubricAxes: string[];
  requiredPolicyGates: QaoPolicyGate[];
  expectedEvidence: {
    mustShow: string[];
    mustAvoid: string[];
  };
  privacy: {
    sensitivity: 'public_synthetic' | 'synthetic_sensitive' | 'operator_approved';
    containsLiveCompanionData: boolean;
    notes: string;
  };
  projectionShape?: QaoProjectionShape;
  macroPurity?: {
    fixtureValuesOnly: boolean;
    personalityPhrasingOwnedByAnchors: boolean;
    forbiddenPromptPhrases?: string[];
  };
}

export interface QaoScenarioRegistry {
  schemaVersion: typeof QAO_SCHEMA_VERSION;
  artifactType: 'psfn.qao_personality_gate_scenarios';
  scenarios: QaoScenario[];
}

export function parseQaoGoldenAnchorSet(value: unknown, field = 'anchorSet'): QaoGoldenAnchorSet {
  const record = parseRecord(value, field);
  assertSchemaVersion(record.schemaVersion, `${field}.schemaVersion`);
  const artifactType = parseString(record.artifactType, `${field}.artifactType`);
  if (artifactType !== 'psfn.qao_golden_anchors') {
    throw new Error(`${field}.artifactType must be psfn.qao_golden_anchors`);
  }

  const anchors = parseArray(record.anchors, `${field}.anchors`).map((entry, index) =>
    parseAnchorDefinition(entry, `${field}.anchors[${index}]`),
  );
  ensureUniqueIds(anchors, `${field}.anchors`);
  ensureRequiredAnchorSources(anchors, field);

  return {
    schemaVersion: QAO_SCHEMA_VERSION,
    artifactType: 'psfn.qao_golden_anchors',
    anchors,
  };
}

export function parseQaoScenarioRegistry(
  value: unknown,
  anchorSet: QaoGoldenAnchorSet,
  field = 'registry',
): QaoScenarioRegistry {
  const anchors = parseQaoGoldenAnchorSet(anchorSet, 'anchorSet');
  const record = parseRecord(value, field);
  assertSchemaVersion(record.schemaVersion, `${field}.schemaVersion`);
  const artifactType = parseString(record.artifactType, `${field}.artifactType`);
  if (artifactType !== 'psfn.qao_personality_gate_scenarios') {
    throw new Error(`${field}.artifactType must be psfn.qao_personality_gate_scenarios`);
  }

  const anchorSources = new Set(anchors.anchors.map((anchor) => anchor.source));
  const scenarios = parseArray(record.scenarios, `${field}.scenarios`).map((entry, index) =>
    parseScenario(entry, anchorSources, `${field}.scenarios[${index}]`),
  );
  ensureUniqueIds(scenarios, `${field}.scenarios`);

  return {
    schemaVersion: QAO_SCHEMA_VERSION,
    artifactType: 'psfn.qao_personality_gate_scenarios',
    scenarios,
  };
}

function parseAnchorDefinition(value: unknown, field: string): QaoAnchorDefinition {
  const record = parseRecord(value, field);
  const source = parseAnchorSource(record.source, `${field}.source`);
  const required = parseBoolean(record.required, `${field}.required`);
  const approved = record.approved === undefined ? undefined : parseBoolean(record.approved, `${field}.approved`);
  if (source === 'operator_primer' && approved !== true) {
    throw new Error(`${field}.approved must be true for operator_primer anchors`);
  }
  if (source !== 'operator_primer' && required !== true) {
    throw new Error(`${field}.required must be true for ${source} anchors`);
  }

  const anchor: QaoAnchorDefinition = {
    id: parseString(record.id, `${field}.id`),
    source,
    required,
    ...(approved === undefined ? {} : { approved }),
    description: parseSafeString(record.description, `${field}.description`),
    evidenceContract: parseNonEmptyStringArray(record.evidenceContract, `${field}.evidenceContract`),
    privacy: parseAnchorPrivacy(record.privacy, `${field}.privacy`),
  };
  ensureNoForbiddenIdentityAssumption(anchor.id, `${field}.id`);
  return anchor;
}

function parseScenario(value: unknown, anchorSources: ReadonlySet<QaoAnchorSource>, field: string): QaoScenario {
  const record = parseRecord(value, field);
  const prompt = parseSafeString(record.prompt, `${field}.prompt`, { trim: false });
  const parsedAnchorSources = parseNonEmptyStringArray(record.anchorSources, `${field}.anchorSources`)
    .map((entry, index) => {
      const source = parseAnchorSource(entry, `${field}.anchorSources[${index}]`);
      if (!anchorSources.has(source)) {
        throw new Error(`${field}.anchorSources[${index}] references missing anchor source "${source}"`);
      }
      return source;
    });
  const scenario: QaoScenario = {
    id: parseString(record.id, `${field}.id`),
    family: parseScenarioFamily(record.family, `${field}.family`),
    title: parseSafeString(record.title, `${field}.title`),
    prompt,
    anchorSources: [...new Set(parsedAnchorSources)],
    rubricAxes: parseNonEmptyStringArray(record.rubricAxes, `${field}.rubricAxes`),
    requiredPolicyGates: parseNonEmptyStringArray(record.requiredPolicyGates, `${field}.requiredPolicyGates`)
      .map((entry, index) => parsePolicyGate(entry, `${field}.requiredPolicyGates[${index}]`)),
    expectedEvidence: parseExpectedEvidence(record.expectedEvidence, `${field}.expectedEvidence`),
    privacy: parseScenarioPrivacy(record.privacy, `${field}.privacy`),
    ...(record.projectionShape === undefined
      ? {}
      : { projectionShape: parseProjectionShape(record.projectionShape, `${field}.projectionShape`, prompt) }),
    ...(record.macroPurity === undefined ? {} : { macroPurity: parseMacroPurity(record.macroPurity, `${field}.macroPurity`, prompt) }),
  };
  ensureNoForbiddenIdentityAssumption(scenario.id, `${field}.id`);
  validateScenarioCrossFields(scenario, field);
  return scenario;
}

function validateScenarioCrossFields(scenario: QaoScenario, field: string): void {
  if (scenario.privacy.containsLiveCompanionData) {
    throw new Error(`${field}.privacy.containsLiveCompanionData must be false for QAO fixtures`);
  }
  if (scenario.projectionShape && !scenario.requiredPolicyGates.includes('no_raw_memory_records')) {
    throw new Error(`${field}.requiredPolicyGates must include no_raw_memory_records for projectionShape scenarios`);
  }
  if (scenario.family === 'memory_grounded_responses' && !scenario.projectionShape) {
    throw new Error(`${field}.projectionShape is required for memory_grounded_responses`);
  }
  if (
    scenario.family === 'golden_anchor_drift'
    && (!scenario.anchorSources.includes('values_journal') || !scenario.anchorSources.includes('prompt_composer_output'))
  ) {
    throw new Error(`${field}.anchorSources must include values_journal and prompt_composer_output for golden_anchor_drift`);
  }
  if (scenario.macroPurity && !scenario.requiredPolicyGates.includes('prompt_macro_purity')) {
    throw new Error(`${field}.requiredPolicyGates must include prompt_macro_purity when macroPurity is present`);
  }
}

function parseAnchorPrivacy(value: unknown, field: string): QaoAnchorDefinition['privacy'] {
  const record = parseRecord(value, field);
  const containsLiveCompanionData = parseBoolean(record.containsLiveCompanionData, `${field}.containsLiveCompanionData`);
  if (containsLiveCompanionData) {
    throw new Error(`${field}.containsLiveCompanionData must be false`);
  }
  return {
    containsLiveCompanionData,
    sensitivity: parseSensitivity(record.sensitivity, `${field}.sensitivity`),
  };
}

function parseScenarioPrivacy(value: unknown, field: string): QaoScenario['privacy'] {
  const record = parseRecord(value, field);
  return {
    sensitivity: parseSensitivity(record.sensitivity, `${field}.sensitivity`),
    containsLiveCompanionData: parseBoolean(record.containsLiveCompanionData, `${field}.containsLiveCompanionData`),
    notes: parseSafeString(record.notes, `${field}.notes`),
  };
}

function parseExpectedEvidence(value: unknown, field: string): QaoScenario['expectedEvidence'] {
  const record = parseRecord(value, field);
  return {
    mustShow: parseNonEmptyStringArray(record.mustShow, `${field}.mustShow`),
    mustAvoid: parseNonEmptyStringArray(record.mustAvoid, `${field}.mustAvoid`),
  };
}

function parseProjectionShape(value: unknown, field: string, prompt: string): QaoProjectionShape {
  const record = parseRecord(value, field);
  const projectedFields = parseNonEmptyStringArray(record.projectedFields, `${field}.projectedFields`);
  const forbiddenRawStorageFields = parseNonEmptyStringArray(record.forbiddenRawStorageFields, `${field}.forbiddenRawStorageFields`);
  const fieldCeiling = parsePositiveInteger(record.fieldCeiling, `${field}.fieldCeiling`);
  if (fieldCeiling > 5) {
    throw new Error(`${field}.fieldCeiling must be 5 or lower for sparse projected attention`);
  }
  if (projectedFields.length > fieldCeiling) {
    throw new Error(`${field}.projectedFields exceeds fieldCeiling`);
  }
  const allText = [prompt, ...projectedFields].join('\n');
  for (const pattern of RAW_STORAGE_FIELD_PATTERNS) {
    if (pattern.test(allText)) {
      throw new Error(`${field} must not expose raw storage field matching ${String(pattern)}`);
    }
  }

  return {
    profileId: parseString(record.profileId, `${field}.profileId`),
    consumer: parseProjectionConsumer(record.consumer, `${field}.consumer`),
    fieldCeiling,
    projectedFields,
    forbiddenRawStorageFields,
    testsSparseAttentionShape: parseBoolean(record.testsSparseAttentionShape, `${field}.testsSparseAttentionShape`),
  };
}

function parseMacroPurity(value: unknown, field: string, prompt: string): NonNullable<QaoScenario['macroPurity']> {
  const record = parseRecord(value, field);
  const forbiddenPromptPhrases = record.forbiddenPromptPhrases === undefined
    ? []
    : parseNonEmptyStringArray(record.forbiddenPromptPhrases, `${field}.forbiddenPromptPhrases`);
  for (const phrase of forbiddenPromptPhrases) {
    if (prompt.toLowerCase().includes(phrase.toLowerCase())) {
      throw new Error(`${field}.forbiddenPromptPhrases matched prompt phrase "${phrase}"`);
    }
  }
  return {
    fixtureValuesOnly: parseBoolean(record.fixtureValuesOnly, `${field}.fixtureValuesOnly`),
    personalityPhrasingOwnedByAnchors: parseBoolean(record.personalityPhrasingOwnedByAnchors, `${field}.personalityPhrasingOwnedByAnchors`),
    ...(forbiddenPromptPhrases.length === 0 ? {} : { forbiddenPromptPhrases }),
  };
}

function ensureRequiredAnchorSources(anchors: readonly QaoAnchorDefinition[], field: string): void {
  const sources = new Set(anchors.map((anchor) => anchor.source));
  for (const source of REQUIRED_ANCHOR_SOURCES) {
    if (!sources.has(source)) {
      throw new Error(`${field}.anchors missing required anchor source "${source}"`);
    }
  }
}

function ensureUniqueIds(values: readonly { id: string }[], field: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new Error(`${field} contains duplicate id "${value.id}"`);
    }
    ids.add(value.id);
  }
}

function parseAnchorSource(value: unknown, field: string): QaoAnchorSource {
  const parsed = parseString(value, field);
  if (![...REQUIRED_ANCHOR_SOURCES, ...OPTIONAL_ANCHOR_SOURCES].includes(parsed as QaoAnchorSource)) {
    throw new Error(`${field} uses unsupported anchor source "${parsed}"`);
  }
  return parsed as QaoAnchorSource;
}

function parseScenarioFamily(value: unknown, field: string): QaoScenarioFamily {
  const parsed = parseString(value, field);
  if (!SCENARIO_FAMILIES.includes(parsed as QaoScenarioFamily)) {
    throw new Error(`${field} uses unsupported scenario family "${parsed}"`);
  }
  return parsed as QaoScenarioFamily;
}

function parsePolicyGate(value: unknown, field: string): QaoPolicyGate {
  const parsed = parseString(value, field);
  if (!POLICY_GATES.includes(parsed as QaoPolicyGate)) {
    throw new Error(`${field} uses unsupported policy gate "${parsed}"`);
  }
  return parsed as QaoPolicyGate;
}

function parseSensitivity(value: unknown, field: string): QaoScenario['privacy']['sensitivity'] {
  const parsed = parseString(value, field);
  if (parsed !== 'public_synthetic' && parsed !== 'synthetic_sensitive' && parsed !== 'operator_approved') {
    throw new Error(`${field} uses unsupported sensitivity "${parsed}"`);
  }
  return parsed;
}

function parseProjectionConsumer(value: unknown, field: string): QaoProjectionShape['consumer'] {
  const parsed = parseString(value, field);
  if (parsed !== 'agent_context' && parsed !== 'main_mind_pass' && parsed !== 'background_llm' && parsed !== 'appraisal') {
    throw new Error(`${field} uses unsupported projection consumer "${parsed}"`);
  }
  return parsed;
}

function assertSchemaVersion(value: unknown, field: string): void {
  if (value !== QAO_SCHEMA_VERSION) {
    throw new Error(`${field} must be ${String(QAO_SCHEMA_VERSION)}`);
  }
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function parseRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function parseString(value: unknown, field: string, options: { trim?: boolean } = {}): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const normalized = options.trim === false ? value : value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

function parseSafeString(value: unknown, field: string, options: { trim?: boolean } = {}): string {
  const parsed = parseString(value, field, options);
  ensureNoForbiddenIdentityAssumption(parsed, field);
  return parsed;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function parseNonEmptyStringArray(value: unknown, field: string): string[] {
  const values = parseArray(value, field).map((entry, index) => parseSafeString(entry, `${field}[${index}]`));
  const deduped = [...new Set(values)];
  if (deduped.length === 0) {
    throw new Error(`${field} must contain at least one value`);
  }
  return deduped;
}

function ensureNoForbiddenIdentityAssumption(value: string, field: string): void {
  for (const pattern of FORBIDDEN_IDENTITY_ASSUMPTIONS) {
    if (pattern.test(value)) {
      throw new Error(`${field} must not assume ${String(pattern)}`);
    }
  }
}

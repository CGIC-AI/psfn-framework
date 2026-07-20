// Persisted-state proof validators for Sprint 10 shakedown cases.
//
// These validators never inspect the model's claimed result. Their inputs are
// the canonical TurnRecord, owner/config snapshots, Postgres rows, and
// operator/Garden audit artifacts collected by the case. A missing artifact is
// a failure, including for read-only cases where narration-without-execution
// detection would otherwise be inapplicable.

const HISTORY_STAMP_LINE_PREFIX = /^\[[A-Z][a-z]{2} \d{2}-\d{2}-\d{2} \d{2}:\d{2}\]/mu;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function snapshotOf(turnRecord) {
  return turnRecord?.snapshot ?? turnRecord?.observability?.snapshot ?? null;
}

function promptSections(turnRecord, key) {
  return asArray(snapshotOf(turnRecord)?.promptContext?.[key]);
}

function sectionById(turnRecord, key, id) {
  return promptSections(turnRecord, key).find((section) => section?.id === id) ?? null;
}

function sectionText(section) {
  return typeof section?.content === 'string'
    ? section.content
    : typeof section?.renderedText === 'string'
      ? section.renderedText
      : '';
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function completedTurnFailures(turnRecord) {
  const failures = [];
  if (!turnRecord || typeof turnRecord !== 'object') {
    failures.push('exact persisted TurnRecord is missing');
    return failures;
  }
  if (turnRecord.status !== 'completed') {
    failures.push(`persisted TurnRecord must be completed (got ${String(turnRecord.status)})`);
  }
  if (typeof turnRecord.userMessage?.content !== 'string') {
    failures.push('persisted TurnRecord user message is missing');
  }
  return failures;
}

export function validateSituatedPresenceProof({ turnRecord, expected = {} }) {
  const failures = completedTurnFailures(turnRecord);
  const section = sectionById(
    turnRecord,
    'runtimeContextSections',
    'runtime_situated_presence',
  );
  const content = sectionText(section);

  if (expected.mode === 'placeless') {
    if (section || content.includes('<runtime_situated_presence')) {
      failures.push('placeless turn must not persist runtime_situated_presence');
    }
    if (turnRecord?.location?.placeId) {
      failures.push('placeless turn must not persist a location.placeId');
    }
    return failures;
  }

  if (!section) {
    failures.push('persisted runtime_situated_presence section is missing');
    return failures;
  }
  if (!content.includes('<runtime_situated_presence')) {
    failures.push('runtime_situated_presence section is not the wrapped persisted block');
  }

  if (expected.mode === 'physical') {
    if (typeof expected.placeId === 'string' && turnRecord?.location?.placeId !== expected.placeId) {
      failures.push(
        `physical turn location.placeId must be ${expected.placeId} (got ${String(turnRecord?.location?.placeId)})`,
      );
    }
    if (!content.includes('(physical place)')) {
      failures.push('physical situated section must identify a physical place');
    }
    if (content.includes('Shared mindspace:')) {
      failures.push('physical turn must take precedence over the shared-mindspace fallback');
    }
    if (expected.placeLabel && !content.includes(expected.placeLabel)) {
      failures.push(`physical situated section is missing place label ${expected.placeLabel}`);
    }
    if (expected.affordanceLabel && !content.includes(expected.affordanceLabel)) {
      failures.push(`physical situated section is missing affordance ${expected.affordanceLabel}`);
    }
    return failures;
  }

  if (expected.mode === 'mindspace') {
    if (!content.includes('Shared mindspace:')) {
      failures.push('mindspace turn is missing the Shared mindspace declaration');
    }
    const places = asArray(expected.placesRegistry?.places);
    const virtual = places.find((place) => place?.placeId === expected.placeId);
    if (!virtual || virtual.kind !== 'virtual') {
      failures.push(`places.json is missing virtual mindspace place ${String(expected.placeId)}`);
      return failures;
    }
    if (virtual.mirrorsPlaceId !== expected.mirrorsPlaceId) {
      failures.push(
        `mindspace ${String(expected.placeId)} must mirror ${String(expected.mirrorsPlaceId)}`,
      );
      return failures;
    }
    const mirrored = places.find((place) => place?.placeId === expected.mirrorsPlaceId);
    if (!mirrored || mirrored.kind !== 'physical') {
      failures.push(`places.json mirror target ${String(expected.mirrorsPlaceId)} is not physical`);
    } else if (!content.includes(`virtual twin of ${mirrored.displayName ?? mirrored.placeId}`)) {
      failures.push('mindspace persisted block does not identify its physical mirror');
    }
    return failures;
  }

  failures.push(`unknown situated-presence proof mode ${String(expected.mode)}`);
  return failures;
}

export function validateWorldReadProof({ turnRecord, sideChecks }) {
  const failures = completedTurnFailures(turnRecord);
  const telemetry = sideChecks?.world?.telemetry;
  if (telemetry?.status !== 202 || typeof telemetry?.eventId !== 'string') {
    failures.push('synthetic external telemetry was not accepted with a durable event id');
  }
  if (sideChecks?.world?.gardenAuditFound !== true) {
    failures.push('Garden audit does not contain the ingested telemetry event id');
  }
  const calls = asArray(turnRecord?.toolCalls)
    .filter((call) => call?.toolName === 'world' && call?.isError !== true);
  const actions = new Set(calls.map((call) => call?.arguments?.action));
  if (!actions.has('list')) failures.push('persisted TurnRecord is missing world action=list');
  if (!actions.has('perceive')) failures.push('persisted TurnRecord is missing world action=perceive');
  return failures;
}

export function validateHubIdentityProof({ turnRecord, sideChecks }) {
  const failures = completedTurnFailures(turnRecord);
  const hub = sideChecks?.hubIdentity;
  if (hub?.enrollment?.status !== 'enrolled') {
    failures.push('hub identity enrollment row was not persisted as enrolled');
  }
  if (hub?.enrollment?.hubIdentityId !== hub?.expected?.hubIdentityId) {
    failures.push('hub identity enrollment row does not match the opaque identity claim');
  }
  if (hub?.enrollment?.contactId !== hub?.expected?.contactId) {
    failures.push('hub identity enrollment row does not bind the canonical contact');
  }
  if (hub?.enrollmentAudit?.action !== 'enroll') {
    failures.push('hub identity enrollment audit row is missing');
  }
  if (
    hub?.telemetry?.status !== 202
    || typeof hub?.telemetry?.eventId !== 'string'
    || hub?.telemetry?.gardenAuditFound !== true
  ) {
    failures.push('hub identity face telemetry is missing its accepted Garden-audit proof');
  }
  if (hub?.expected?.priorPlaceId === hub?.expected?.placeId) {
    failures.push('hub presence-follow precondition did not distinguish the destination place');
  }
  if (hub?.internalState?.placeId !== hub?.expected?.placeId) {
    failures.push('internal_state_snapshots did not follow the enrolled face claim place');
  }
  if (
    hub?.expected?.requireSharedPresence === true
    && (
      hub?.presence?.placeId !== hub?.expected?.placeId
      || hub?.presence?.placeId !== hub?.internalState?.placeId
    )
  ) {
    failures.push('shared companion_presence does not follow the persisted internal-state place');
  }
  if (hub?.cleanup?.revoked !== true) {
    failures.push('temporary hub identity enrollment was not revoked during cleanup');
  }
  if (hub?.cleanup?.restoredPlaceId !== hub?.expected?.restorePlaceId) {
    failures.push('hub identity cleanup did not restore the physical presence precondition');
  }
  return failures;
}

export function validateCogSecDocumentProof({ sideChecks }) {
  const failures = [];
  const proof = sideChecks?.cogsec;
  if (proof?.quarantine?.found !== true
    || proof?.quarantine?.status !== 'held'
    || proof?.quarantine?.envelopeState !== 'quarantined') {
    failures.push('document token is missing from the durable held quarantine envelope');
  }
  if (!/^[a-f0-9]{64}$/u.test(proof?.quarantine?.rawSha256 ?? '')) {
    failures.push('quarantine evidence must expose only a SHA-256 raw-content proof');
  }
  if (
    proof?.gardenQueue?.found !== true
    || proof?.gardenQueue?.status !== 'held'
    || proof?.gardenQueue?.contentSha256Matches !== true
  ) {
    failures.push('held document is missing from the Garden quarantine queue or its content hash differs');
  }
  if (
    proof?.resolution?.action !== 'discard'
    || proof?.resolution?.confirmed !== true
    || proof?.resolution?.applied !== true
  ) {
    failures.push('synthetic quarantine fixture was not resolved through the two-step Garden decision path');
  }
  if (proof?.session?.found !== true
    || proof?.session?.withheld !== true
    || proof?.session?.envelopeState !== 'quarantined') {
    failures.push('persisted user session entry is missing its quarantined intake envelope');
  }
  if (proof?.session?.fixedNoticePresent !== true) {
    failures.push('persisted user entry does not contain the fixed intake-firewall notice');
  }
  const jobs = asArray(proof?.backgroundJobs);
  for (const kind of ['memory_extraction', 'emotion_appraisal']) {
    const job = jobs.find((candidate) => candidate?.kind === kind);
    if (job?.state !== 'succeeded') {
      failures.push(`${kind} background proof did not reach succeeded state`);
    }
  }
  if (proof?.memoryLeakCount !== 0) {
    failures.push(`quarantined token leaked into ${String(proof?.memoryLeakCount)} durable memory row(s)`);
  }
  if (proof?.appraisalLeakCount !== 0) {
    failures.push(`quarantined token leaked into ${String(proof?.appraisalLeakCount)} appraisal section(s)`);
  }
  return failures;
}

export function validateTemporalProof({ turnRecord }) {
  const failures = completedTurnFailures(turnRecord);
  const section = sectionById(turnRecord, 'finalSystemSections', 'runtime.current_datetime');
  const content = sectionText(section);
  if (!section || !content.includes('<runtime.current_datetime')) {
    failures.push('persisted finalSystemSections is missing runtime.current_datetime');
  }
  const planMessages = asArray(snapshotOf(turnRecord)?.plan?.messages);
  if (!planMessages.some((message) => (
    typeof message?.content === 'string'
    && HISTORY_STAMP_LINE_PREFIX.test(message.content)
  ))) {
    failures.push('persisted PromptPlan history contains no rendered history stamp');
  }
  const rawResponse = snapshotOf(turnRecord)?.promptContext?.response?.content;
  if (typeof rawResponse !== 'string' || !HISTORY_STAMP_LINE_PREFIX.test(rawResponse)) {
    failures.push('raw persisted model response did not exercise the history-stamp strip guard');
  }
  const assistant = turnRecord?.assistantMessage?.content;
  if (typeof assistant !== 'string' || assistant.trim().length === 0) {
    failures.push('persisted assistant reply is missing');
  } else if (assistant.split('\n').some((line) => HISTORY_STAMP_LINE_PREFIX.test(line))) {
    failures.push('persisted assistant reply leaked a leading conversation-history stamp');
  }
  return failures;
}

export function validateSseTurnProof({ turnRecord, sideChecks }) {
  const failures = completedTurnFailures(turnRecord);
  const stream = sideChecks?.sse;
  if (asArray(stream?.parseErrors).length > 0) {
    failures.push(`SSE stream contained ${String(stream.parseErrors.length)} malformed data frame(s)`);
  }
  if (!finiteNonNegative(stream?.firstContentAtMs) || !stream?.firstContent) {
    failures.push('SSE stream produced no first non-empty content delta');
  }
  if (!finiteNonNegative(stream?.terminalAtMs)) {
    failures.push('SSE stream produced no terminal event');
  } else if (
    finiteNonNegative(stream?.firstContentAtMs)
    && stream.firstContentAtMs > stream.terminalAtMs
  ) {
    failures.push('SSE first content delta arrived after the terminal event');
  }
  if (
    typeof stream?.contentText !== 'string'
    || stream.contentText.length === 0
    || stream.contentText !== turnRecord?.assistantMessage?.content
  ) {
    failures.push('SSE content does not match the exact persisted TurnRecord assistant message');
  }
  const firstToken = asArray(turnRecord?.observability?.stages)
    .find((stage) => stage?.stage === 'first-token');
  const ttft = firstToken?.data?.ttftMs ?? firstToken?.elapsedMs;
  if (firstToken?.data?.source !== 'stream' || !finiteNonNegative(ttft)) {
    failures.push('persisted TurnRecord is missing finite stream first-token/ttft observability');
  }
  return failures;
}

export async function validatePersistedProof(testCase, evidence) {
  if (!testCase?.proof) return [];
  if (typeof testCase.validatePersistedProof !== 'function') {
    return [`case ${String(testCase.id)} declares persisted proof but has no validator`];
  }
  try {
    const failures = await testCase.validatePersistedProof(evidence);
    if (!Array.isArray(failures)) {
      return [`case ${String(testCase.id)} persisted proof validator returned a non-array`];
    }
    return failures
      .filter((failure) => typeof failure === 'string' && failure.trim().length > 0)
      .map((failure) => failure.trim());
  } catch (error) {
    return [
      `case ${String(testCase.id)} persisted proof validator threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

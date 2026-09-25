/**
 * Shared-room isolation between harness cases (psfn-framework-66cus).
 *
 * The testing-harness principal deliberately collapses every case into one
 * persistent room (api:testing-harness). When a case's turn fails without an
 * assistant reply, its user message stays unanswered in that room and the next
 * case's turn sees it as live context. The harness therefore tracks whether
 * the room's latest dispatch was answered, settles the room with one explicit
 * boundary turn before the next case, and, when settling fails, labels a
 * failing next case `contaminated` instead of blaming its own probe.
 */

export const SHARED_HARNESS_ROOM_CHANNEL_ID = 'api:testing-harness';

export const ROOM_SETTLE_REPLY = 'settled';

export const ROOM_SETTLE_MESSAGE =
  'Shakedown harness boundary: the previous test case ended without your reply. '
  + 'Treat every earlier unanswered request in this room as withdrawn and do not act on it. '
  + `Do not call any tool. Reply with exactly: ${ROOM_SETTLE_REPLY}`;

/**
 * Tracks whether the shared room holds an unanswered user message. A dispatch
 * marks the room pending before the request is sent, so a dispatch that throws
 * or times out stays pending; only an answered turn clears it.
 */
export function createSharedRoomLedger() {
  let pending = null;
  return {
    dispatchStarted({ roomChannelId, sessionId }) {
      if (roomChannelId !== SHARED_HARNESS_ROOM_CHANNEL_ID) return;
      pending = { sessionId };
    },
    dispatchSettled({ roomChannelId, answered }) {
      if (roomChannelId !== SHARED_HARNESS_ROOM_CHANNEL_ID) return;
      if (answered === true) pending = null;
    },
    pending() {
      return pending;
    },
  };
}

/**
 * Run the single settle turn. `runSettleTurn` dispatches ROOM_SETTLE_MESSAGE
 * through the normal chat path (which updates the ledger). Returns the
 * isolation outcome for the next case.
 */
export async function settleSharedRoom({ ledger, fromCaseId, runSettleTurn }) {
  if (ledger.pending() === null) return null;
  let error = null;
  try {
    await runSettleTurn(ROOM_SETTLE_MESSAGE);
  } catch (settleError) {
    error = settleError instanceof Error ? `${settleError.name}: ${settleError.message}` : String(settleError);
  }
  const settled = ledger.pending() === null;
  return {
    fromCaseId,
    settled,
    ...(error ? { error } : {}),
  };
}

/**
 * Attach the pre-case settle outcome to the next case. A case that ran after a
 * failed settle and did not pass is `contaminated`, keeping its own status as
 * evidence; a passing case keeps `ok`.
 */
export function applyRoomIsolationOutcome(caseResult, outcome) {
  if (!outcome) return caseResult;
  const withEvidence = {
    ...caseResult,
    sideChecks: { ...(caseResult.sideChecks ?? {}), preCaseRoomSettle: outcome },
  };
  if (outcome.settled || caseResult.caseStatus === 'ok') return withEvidence;
  return {
    ...withEvidence,
    caseStatus: 'contaminated',
    contaminatedCaseStatus: caseResult.caseStatus,
    failureReason: `contaminated:unanswered_turn_from:${outcome.fromCaseId}`,
  };
}

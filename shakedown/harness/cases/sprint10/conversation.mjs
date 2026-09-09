import {
  describeChatDispatchFailure,
  postChatCompletion,
  requireCaseChatHeaders,
} from '../../lib/probe.mjs';
import { CaseConfigurationError } from '../../lib/case-execution.mjs';
import {
  validateSseTurnProof,
  validateTemporalProof,
} from '../../lib/persisted-proofs.mjs';
import { probeSseChatCompletion } from '../../lib/sse-probe.mjs';
import {
  normalizeCustomOutcome,
  proof,
} from './common.mjs';

const TEMPORAL_MESSAGE = 'Quote a previously rendered history line with its exact provenance stamp.';
const SSE_MESSAGE = 'Reply with one short sentence for the SSE first-chunk proof.';
const HISTORY_STAMP_PREFIX = /^\[[A-Z][a-z]{2} \d{2}-\d{2}-\d{2} \d{2}:\d{2}\] /u;

function snapshotOf(turnRecord) {
  return turnRecord?.snapshot ?? turnRecord?.observability?.snapshot ?? null;
}

export function extractRenderedHistoryStamp(turnRecord, historyMessage) {
  const planMessages = Array.isArray(snapshotOf(turnRecord)?.plan?.messages)
    ? snapshotOf(turnRecord).plan.messages
    : [];
  for (const message of planMessages.toReversed()) {
    if (typeof message?.content !== 'string') continue;
    for (const line of message.content.split('\n')) {
      const match = line.match(HISTORY_STAMP_PREFIX);
      if (match && line.slice(match[0].length) === historyMessage) {
        return match[0].trimEnd();
      }
    }
  }
  throw new Error('temporal preview PromptPlan does not contain the seeded history turn stamp');
}

export function buildTemporalMessage(seedStamp, seedMessage) {
  return 'Quote this previously rendered history line exactly, including its truthful provenance prefix, '
    + `and output nothing else:\n${seedStamp} ${seedMessage}`;
}

// Dispatch one turn and bind it to its persisted record.
//
// A refused dispatch (non-2xx, or a transport failure) is reported as itself:
// the gateway's status and error envelope, not a downstream "turn did not
// complete" with no request to look at. No turn record can ever exist for a
// request the gateway never accepted, so waiting for one only hides the cause.
async function postAndWait({
  services,
  sessionId,
  apiUserId,
  message,
  signal,
  stage,
}) {
  const startedAtMs = Date.now();
  const response = await postChatCompletion({
    apiUrl: services.apiUrl,
    headers: services.chatHeaders({ sessionId, privacy: 'private' }),
    message,
    timeoutMs: 120_000,
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `${stage} chat dispatch was refused: ${describeChatDispatchFailure(response)}`,
    );
  }
  const turnRecord = await services.waitForTurnRecord({
    sessionId,
    apiUserId,
    message,
    minStartedAtMs: startedAtMs - 2_000,
    timeoutMs: 120_000,
    signal,
  });
  return { response, turnRecord, startedAtMs };
}

export function buildConversationCases(ctx, services) {
  requireCaseChatHeaders(services, 'Sprint 10 conversation cases');
  return [
    {
      id: 's10_temporal_stamp_strip',
      tier: 'nursery',
      variants: ['local', 'kube'],
      feature: 'psfn-framework-2x37',
      sessionId: `s10-temporal-${ctx.runToken}`,
      message: TEMPORAL_MESSAGE,
      proof: proof(
        'TurnRecord PromptPlan history, raw response snapshot, and persisted assistant message',
        'history is rendered with stamps, the model emits one, and the accepted outbound text strips it',
      ),
      execute: async ({ sessionId, apiUserId, signal }) => {
        const seedMessage = `Temporal strip-guard history witness ${ctx.runToken}.`;
        const seed = await postAndWait({
          services,
          sessionId,
          apiUserId,
          message: seedMessage,
          signal,
          stage: 'temporal history seed',
        });
        if (seed.turnRecord?.status !== 'completed') {
          throw new Error(
            'temporal history seed turn did not complete '
            + `(accepted as HTTP ${seed.response.status}; persisted status `
            + `${seed.turnRecord?.status ?? 'no turn record'})`,
          );
        }
        const previewMessage = 'Acknowledge the temporal rendering probe in one word.';
        const preview = await postAndWait({
          services,
          sessionId,
          apiUserId,
          message: previewMessage,
          signal,
          stage: 'temporal history preview',
        });
        if (preview.turnRecord?.status !== 'completed') {
          throw new Error(
            'temporal history preview turn did not complete '
            + `(accepted as HTTP ${preview.response.status}; persisted status `
            + `${preview.turnRecord?.status ?? 'no turn record'})`,
          );
        }
        const seedStamp = extractRenderedHistoryStamp(preview.turnRecord, seedMessage);
        const temporalMessage = buildTemporalMessage(seedStamp, seedMessage);
        const main = await postAndWait({
          services,
          sessionId,
          apiUserId,
          message: temporalMessage,
          signal,
          stage: 'temporal stamp-strip turn',
        });
        const rawResponse = snapshotOf(main.turnRecord)?.promptContext?.response?.content;
        if (
          typeof rawResponse !== 'string'
          || !rawResponse.split('\n').some((line) => line.startsWith(`${seedStamp} `))
        ) {
          throw new CaseConfigurationError(
            'model_probe_not_exercised:history_stamp_echo',
            's10_temporal_stamp_strip model response did not echo the exact seeded history stamp',
          );
        }
        return normalizeCustomOutcome({
          sessionId,
          request: {
            privacy: 'private',
            message: temporalMessage,
            seededHistoryTurnId: seed.turnRecord?.turnId ?? null,
            previewTurnId: preview.turnRecord?.turnId ?? null,
            seededHistoryStamp: seedStamp,
            seededHistoryMessage: seedMessage,
          },
          response: main.response,
          turnRecord: main.turnRecord,
          busyObservedAtMs: main.startedAtMs,
        });
      },
      validatePersistedProof: validateTemporalProof,
    },
    {
      id: 's10_sse_first_chunk',
      tier: 'nursery',
      variants: ['local', 'kube'],
      feature: 'psfn-framework-mmo9',
      sessionId: `s10-sse-${ctx.runToken}`,
      message: SSE_MESSAGE,
      proof: proof(
        'SSE event chronology plus exact TurnRecord observability stages',
        'first non-empty content delta precedes terminal and persists finite stream TTFT',
      ),
      execute: async ({ sessionId, apiUserId, signal }) => {
        const result = await probeSseChatCompletion({
          apiUrl: services.apiUrl,
          headers: services.chatHeaders({ sessionId, privacy: 'private' }),
          message: SSE_MESSAGE,
          signal,
          waitForTurnRecord: async ({ message, minStartedAtMs, timeoutMs }) => (
            services.waitForTurnRecord({
              sessionId,
              apiUserId,
              message,
              minStartedAtMs,
              timeoutMs,
              signal,
            })
          ),
        });
        return normalizeCustomOutcome({
          sessionId,
          request: {
            privacy: 'private',
            message: SSE_MESSAGE,
            stream: true,
          },
          response: result.response,
          turnRecord: result.turnRecord,
          busyObservedAtMs: result.startedAtMs,
          sideChecks: { sse: result.stream },
        });
      },
      after: async ({ outcome }) => ({
        sse: outcome?.sideChecks?.sse ?? null,
      }),
      validatePersistedProof: validateSseTurnProof,
    },
  ];
}

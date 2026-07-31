import {
  buildChatHeaders,
  postChatCompletion,
} from '../../lib/probe.mjs';
import {
  validateSseTurnProof,
  validateTemporalProof,
} from '../../lib/persisted-proofs.mjs';
import { probeSseChatCompletion } from '../../lib/sse-probe.mjs';
import {
  normalizeCustomOutcome,
  proof,
} from './common.mjs';

const TEMPORAL_MESSAGE = 'Answer with one short sentence about the current date and begin the draft '
  + 'by echoing the exact rendered stamp from the seeded history turn.';
const SSE_MESSAGE = 'Reply with one short sentence for the SSE first-chunk proof.';
const HISTORY_STAMP_PREFIX = /^\[[A-Z][a-z]{2} \d{2}-\d{2}-\d{2} \d{2}:\d{2}\] /u;

function snapshotOf(turnRecord) {
  return turnRecord?.snapshot ?? turnRecord?.observability?.snapshot ?? null;
}

export function extractRenderedHistoryStamp(turnRecord, historyMessage) {
  const planMessages = Array.isArray(snapshotOf(turnRecord)?.plan?.messages)
    ? snapshotOf(turnRecord).plan.messages
    : [];
  for (const message of planMessages) {
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

export function buildTemporalMessage(seedStamp) {
  return 'Answer with one short sentence about the current date. '
    + `The seeded history turn above has the exact rendered prefix "${seedStamp} ". `
    + 'For this synthetic strip-guard probe, begin the draft by echoing that exact prefix before the sentence.';
}

async function postAndWait({
  services,
  sessionId,
  apiUserId,
  message,
  signal,
}) {
  const startedAtMs = Date.now();
  const response = await postChatCompletion({
    apiUrl: services.apiUrl,
    headers: buildChatHeaders({
      apiKey: services.apiKey,
      sessionId,
      privacy: 'private',
    }),
    message,
    timeoutMs: 120_000,
    signal,
  });
  const turnRecord = await services.waitForTurnRecord({
    sessionId,
    apiUserId,
    message,
    minStartedAtMs: startedAtMs - 2_000,
    timeoutMs: 120_000,
    signal,
  });
  return { response, turnRecord };
}

export function buildConversationCases(ctx, services) {
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
        const seedMessage = 'Remember that this is the first turn of the temporal rendering probe.';
        const seed = await postAndWait({
          services,
          sessionId,
          apiUserId,
          message: seedMessage,
          signal,
        });
        if (seed.turnRecord?.status !== 'completed') {
          throw new Error('temporal history seed turn did not complete');
        }
        const previewMessage = 'Acknowledge the temporal rendering probe in one word.';
        const preview = await postAndWait({
          services,
          sessionId,
          apiUserId,
          message: previewMessage,
          signal,
        });
        if (preview.turnRecord?.status !== 'completed') {
          throw new Error('temporal history preview turn did not complete');
        }
        const seedStamp = extractRenderedHistoryStamp(preview.turnRecord, seedMessage);
        const temporalMessage = buildTemporalMessage(seedStamp);
        const main = await postAndWait({
          services,
          sessionId,
          apiUserId,
          message: temporalMessage,
          signal,
        });
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
          headers: buildChatHeaders({
            apiKey: services.apiKey,
            sessionId,
            privacy: 'private',
          }),
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

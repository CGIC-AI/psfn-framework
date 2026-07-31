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

const TEMPORAL_MESSAGE = 'Answer with one short sentence about the current date. '
  + 'For this synthetic strip-guard probe, begin the draft with exactly '
  + '"[Fri 07-17-26 12:00] " before the sentence.';
const SSE_MESSAGE = 'Reply with one short sentence for the SSE first-chunk proof.';

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
        const main = await postAndWait({
          services,
          sessionId,
          apiUserId,
          message: TEMPORAL_MESSAGE,
          signal,
        });
        return normalizeCustomOutcome({
          sessionId,
          request: {
            privacy: 'private',
            message: TEMPORAL_MESSAGE,
            seededHistoryTurnId: seed.turnRecord?.turnId ?? null,
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

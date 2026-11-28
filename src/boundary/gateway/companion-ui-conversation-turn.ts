import type {
  ApiChatCompletionRpcSuccess,
  ApiRuntimeChatRequest,
  ApiServerRuntime,
} from '../../channels/api/types.js';
import { CompanionUiInteractionCancelledError } from '../../channels/api/companion-ui-action-failure.js';

type CompanionUiTurnAuthority = Omit<
  ApiRuntimeChatRequest,
  'request' | 'signal' | 'onDelta' | 'companionId'
>;

/**
 * One main-conversation Companion UI turn, shared by the operator-key, fleet
 * SSO and guest brokers (psfn-framework-mg891). The prompt is the exact
 * signed frame content; each path supplies only its own server-derived
 * authority. When the requesting socket negotiated reply deltas, the turn
 * streams through the gateway's request-bound API stream and every delta goes
 * to that socket's own sink. An interrupt that cancels the turn yields a
 * typed cancellation the socket reports as a terminal without closing.
 */
export async function runCompanionUiConversationTurn(input: Readonly<{
  runtime: Pick<ApiServerRuntime, 'handleChatCompletion'>;
  /** Model selector: the companion the frame was compiled for. */
  companionId: string;
  /** Present only when the gateway routes this turn by explicit companion. */
  routeCompanionId?: string;
  content: string;
  authority: CompanionUiTurnAuthority;
  signal: AbortSignal;
  onReplyDelta?: (text: string) => void;
}>): Promise<Omit<ApiChatCompletionRpcSuccess['response'], 'companionId'>> {
  const result = await input.runtime.handleChatCompletion({
    ...input.authority,
    ...(input.routeCompanionId ? { companionId: input.routeCompanionId } : {}),
    request: {
      model: input.companionId,
      messages: [{ role: 'user', content: input.content }],
      system_prompt_mode: 'default',
      ...(input.onReplyDelta ? { stream: true } : {}),
    },
    signal: input.signal,
    ...(input.onReplyDelta ? { onDelta: input.onReplyDelta } : {}),
  });
  if (!result.ok) {
    // An interrupted turn may end as a cancellation or as the error its
    // aborted run produced; either way the browser asked for it to stop.
    if (input.signal.aborted) throw new CompanionUiInteractionCancelledError();
    throw new Error(result.error.type);
  }
  // Routing provenance stays at the gateway; the browser receives only its
  // canonical response fields for the selected socket.
  const { companionId: _companionId, ...response } = result.response;
  return response;
}

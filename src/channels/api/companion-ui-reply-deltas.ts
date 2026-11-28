import {
  COMPANION_UI_PROTOCOL_LIMITS,
  type CompanionUiActionResource,
} from '../../boundary/fleet-auth/companion-ui-action.js';

/** Prompt resources whose typed reply may stream to the requesting socket. */
const STREAMING_RESOURCES: ReadonlySet<CompanionUiActionResource> = new Set([
  'conversation.interact',
  'conversation.touch',
]);

export interface CompanionUiReplyDeltaFrame {
  readonly schemaVersion: 1;
  readonly type: 'delta';
  readonly requestId: string;
  readonly sequence: number;
  readonly text: string;
}

/**
 * One request's server-owned reply-delta tap (psfn-framework-mg891). It is
 * created by the socket that admitted the action frame, so frames correlate
 * only to that socket's own request; nothing is routed by a browser-supplied
 * identifier. Deltas are bounded by the same text ceiling as the terminal
 * reply and stop once the terminal `result` is about to be sent, so a delta
 * can never follow its terminal.
 */
export class CompanionUiReplyDeltaStream {
  private sequence = 0;
  private characters = 0;
  private open = true;

  private constructor(
    private readonly requestId: string,
    private readonly send: (frame: CompanionUiReplyDeltaFrame) => void,
  ) {}

  static forFrame(input: Readonly<{
    negotiated: boolean;
    resource: CompanionUiActionResource;
    requestId: string;
    send: (frame: CompanionUiReplyDeltaFrame) => void;
  }>): CompanionUiReplyDeltaStream | undefined {
    if (!input.negotiated || !STREAMING_RESOURCES.has(input.resource)) return undefined;
    return new CompanionUiReplyDeltaStream(input.requestId, input.send);
  }

  /** Sink handed to the dispatcher; it drops text after close or past the bound. */
  readonly push = (text: string): void => {
    if (!this.open || text.length === 0) return;
    if (this.characters + text.length > COMPANION_UI_PROTOCOL_LIMITS.maxTextCharacters) {
      // The terminal result still carries the authoritative reply; the
      // browser only loses incremental rendering for an oversized reply.
      this.open = false;
      return;
    }
    this.characters += text.length;
    this.send(Object.freeze({
      schemaVersion: 1,
      type: 'delta',
      requestId: this.requestId,
      sequence: this.sequence,
      text,
    }));
    this.sequence += 1;
  };

  close(): void {
    this.open = false;
  }
}

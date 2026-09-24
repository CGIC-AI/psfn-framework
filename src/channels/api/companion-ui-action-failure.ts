import { CompanionUiActionDeniedError } from '../../boundary/gateway/companion-ui-action-broker.js';
import { CompanionUiProtocolError } from '../../boundary/fleet-auth/companion-ui-action.js';
import { HubDeviceAssertionRejectedError } from '../../boundary/fleet-auth/hub-device-assertion.js';

/**
 * How a failed Companion UI action frame is reported to the browser
 * (psfn-framework-u42t5). `denied` is an authority or protocol refusal the
 * client caused or cannot overcome by retrying; `internal_error` is a server
 * fault (provider outage, preview crash) behind an admitted action. Both close
 * the socket; only the code differs, and neither carries error text.
 */
export type CompanionUiActionFailureCode = 'denied' | 'internal_error';

/** A socket-local authority or protocol refusal (duplicate request id, closed session, ...). */
export class CompanionUiSocketDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

function isDenial(error: unknown): boolean {
  return error instanceof CompanionUiSocketDeniedError
    || error instanceof CompanionUiActionDeniedError
    || error instanceof CompanionUiProtocolError
    || error instanceof HubDeviceAssertionRejectedError;
}

/**
 * Anything that failed before the frame reached its dispatcher is a protocol
 * refusal. Inside dispatch, only a typed refusal is a denial; every other
 * error is an internal failure the operator must see in the log.
 */
export function classifyCompanionUiActionFailure(
  error: unknown,
  dispatching: boolean,
): CompanionUiActionFailureCode {
  if (!dispatching) return 'denied';
  return isDenial(error) ? 'denied' : 'internal_error';
}

export function companionUiActionFailureFrame(
  requestId: string,
  code: CompanionUiActionFailureCode,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: 'result',
    requestId,
    ok: false,
    error: { code },
  };
}

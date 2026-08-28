import type {
  IcpTargetChannelInitiationRequest,
  IcpTargetChannelInitiationResult,
  IcpTargetChannelInitiator,
} from './icp-target-channel-initiation.js';
import type {
  IcpTargetChannelContinuation,
  IcpTargetChannelContinuationRequest,
} from './icp-target-channel-continuation.js';

type IcpTargetChannelCommand = IcpTargetChannelInitiator & Partial<IcpTargetChannelContinuation>;

/**
 * Process-local command port for scheduler-owned ICP initiation work.
 *
 * W4/W5 call this port after the authenticated agent runtime has started. The
 * registered initiator still verifies the durable permit sender binding; this
 * module deliberately does not expose a raw network/RPC initiation surface.
 */
export interface IcpTargetChannelInitiationCommandPort {
  execute(
    request: IcpTargetChannelInitiationRequest,
  ): Promise<IcpTargetChannelInitiationResult>;
  executeContinuation(
    request: IcpTargetChannelContinuationRequest,
  ): ReturnType<IcpTargetChannelContinuation['continueDyad']>;
  executeHumanRelay(
    request: Parameters<IcpTargetChannelContinuation['relayHumanIntent']>[0],
  ): ReturnType<IcpTargetChannelContinuation['relayHumanIntent']>;
}

let activeInitiator: IcpTargetChannelCommand | null = null;

export const icpTargetChannelInitiationCommand: IcpTargetChannelInitiationCommandPort = {
  async execute(request): Promise<IcpTargetChannelInitiationResult> {
    const initiator = activeInitiator;
    if (!initiator) {
      throw new Error('ICP target-channel initiation command is not registered');
    }
    return await initiator.initiate(request);
  },
  async executeContinuation(request) {
    const initiator = activeInitiator;
    const continueDyad = initiator?.continueDyad;
    if (!continueDyad) throw new Error('ICP target-channel continuation command is not registered');
    return await continueDyad(request);
  },
  async executeHumanRelay(request) {
    const relayHumanIntent = activeInitiator?.relayHumanIntent;
    if (!relayHumanIntent) throw new Error('ICP target-channel human relay command is not registered');
    return await relayHumanIntent(request);
  },
};

/** Register the one authenticated agent-runtime implementation for this process. */
export function registerIcpTargetChannelInitiationCommand(
  initiator: IcpTargetChannelCommand,
): () => void {
  if (activeInitiator) {
    throw new Error('ICP target-channel initiation command is already registered');
  }
  activeInitiator = initiator;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    if (activeInitiator === initiator) activeInitiator = null;
  };
}

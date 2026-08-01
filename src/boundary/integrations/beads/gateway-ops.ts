import type { GatewayOpsPort } from '../../gateway/gateway-ops-port.js';
import type {
  BeadsActionResult,
  BeadsCloseParams,
  BeadsCreateParams,
  BeadsReadyParams,
  BeadsShowParams,
  BeadsSyncParams,
  BeadsUpdateParams,
} from '../../gateway/protocol.js';
import type { BeadsOperations } from './ops.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';

function withTrustedChannel<T extends object>(params: T): T {
  const channelId = getRequestContext()?.channelId?.trim();
  return {
    ...params,
    ...(channelId ? { channelId } : {}),
  };
}

export class GatewayBeadsOps implements BeadsOperations {
  private readonly beadsOps: BeadsOperations;

  constructor(gatewayOps: Pick<GatewayOpsPort, 'beads'> | BeadsOperations) {
    this.beadsOps = 'beads' in gatewayOps ? gatewayOps.beads : gatewayOps;
  }

  async ready(params: BeadsReadyParams = {}): Promise<BeadsActionResult> {
    return this.beadsOps.ready(withTrustedChannel(params));
  }

  async show(params: BeadsShowParams): Promise<BeadsActionResult> {
    return this.beadsOps.show(withTrustedChannel(params));
  }

  async create(params: BeadsCreateParams): Promise<BeadsActionResult> {
    return this.beadsOps.create(withTrustedChannel(params));
  }

  async update(params: BeadsUpdateParams): Promise<BeadsActionResult> {
    return this.beadsOps.update(withTrustedChannel(params));
  }

  async close(params: BeadsCloseParams): Promise<BeadsActionResult> {
    return this.beadsOps.close(withTrustedChannel(params));
  }

  async sync(params: BeadsSyncParams = {}): Promise<BeadsActionResult> {
    return this.beadsOps.sync(withTrustedChannel(params));
  }
}

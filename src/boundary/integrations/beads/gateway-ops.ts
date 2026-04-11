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

export class GatewayBeadsOps implements BeadsOperations {
  private readonly beadsOps: BeadsOperations;

  constructor(gatewayOps: Pick<GatewayOpsPort, 'beads'> | BeadsOperations) {
    this.beadsOps = 'beads' in gatewayOps ? gatewayOps.beads : gatewayOps;
  }

  async ready(params: BeadsReadyParams = {}): Promise<BeadsActionResult> {
    return this.beadsOps.ready(params);
  }

  async show(params: BeadsShowParams): Promise<BeadsActionResult> {
    return this.beadsOps.show(params);
  }

  async create(params: BeadsCreateParams): Promise<BeadsActionResult> {
    return this.beadsOps.create(params);
  }

  async update(params: BeadsUpdateParams): Promise<BeadsActionResult> {
    return this.beadsOps.update(params);
  }

  async close(params: BeadsCloseParams): Promise<BeadsActionResult> {
    return this.beadsOps.close(params);
  }

  async sync(params: BeadsSyncParams = {}): Promise<BeadsActionResult> {
    return this.beadsOps.sync(params);
  }
}

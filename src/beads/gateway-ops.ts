import type { GatewayClient } from '../boundary/gateway/client.js';
import type {
  BeadsActionResult,
  BeadsCloseParams,
  BeadsCreateParams,
  BeadsReadyParams,
  BeadsShowParams,
  BeadsSyncParams,
  BeadsUpdateParams,
} from '../boundary/gateway/protocol.js';
import type { BeadsOperations } from './ops.js';

export class GatewayBeadsOps implements BeadsOperations {
  private readonly gateway: GatewayClient;

  constructor(gateway: GatewayClient) {
    this.gateway = gateway;
  }

  async ready(params: BeadsReadyParams = {}): Promise<BeadsActionResult> {
    return this.gateway.beadsReady(params);
  }

  async show(params: BeadsShowParams): Promise<BeadsActionResult> {
    return this.gateway.beadsShow(params);
  }

  async create(params: BeadsCreateParams): Promise<BeadsActionResult> {
    return this.gateway.beadsCreate(params);
  }

  async update(params: BeadsUpdateParams): Promise<BeadsActionResult> {
    return this.gateway.beadsUpdate(params);
  }

  async close(params: BeadsCloseParams): Promise<BeadsActionResult> {
    return this.gateway.beadsClose(params);
  }

  async sync(params: BeadsSyncParams = {}): Promise<BeadsActionResult> {
    return this.gateway.beadsSync(params);
  }
}

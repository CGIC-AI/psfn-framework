import type {
  BeadsActionResult,
  BeadsCloseParams,
  BeadsCreateParams,
  BeadsReadyParams,
  BeadsShowParams,
  BeadsSyncParams,
  BeadsUpdateParams,
} from '../boundary/gateway/protocol.js';

export interface BeadsOperations {
  ready(params?: BeadsReadyParams): Promise<BeadsActionResult>;
  show(params: BeadsShowParams): Promise<BeadsActionResult>;
  create(params: BeadsCreateParams): Promise<BeadsActionResult>;
  update(params: BeadsUpdateParams): Promise<BeadsActionResult>;
  close(params: BeadsCloseParams): Promise<BeadsActionResult>;
  sync(params?: BeadsSyncParams): Promise<BeadsActionResult>;
}

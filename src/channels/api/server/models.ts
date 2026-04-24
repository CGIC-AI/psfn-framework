import type { ServerResponse } from 'node:http';
import { sendJson } from '../../backplane/http/primitives.js';
import { buildModelListResponse } from '../response-format.js';

export function handleModelsEndpoint(res: ServerResponse, modelName: string): void {
  const body = buildModelListResponse(modelName, Math.floor(Date.now() / 1000));
  sendJson(res, 200, body);
}

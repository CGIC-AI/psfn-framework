import { serializeQuery } from '../query';

export function serializeModelUsageQuery(params: URLSearchParams): string {
  return serializeQuery(params);
}

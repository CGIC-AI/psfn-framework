import { encodeCanonicalQueryComponent } from '../../../../src/shared/utils/query-encoding.js';

export function serializeQuery(params: URLSearchParams): string {
  return [...params].map(([key, value]) => (
    `${encodeCanonicalQueryComponent(key)}=${encodeCanonicalQueryComponent(value)}`
  )).join('&');
}

export function withQuery(path: string, params: URLSearchParams): string {
  const query = serializeQuery(params);
  if (!query) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

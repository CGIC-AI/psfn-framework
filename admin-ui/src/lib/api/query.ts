export function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  if (!query) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

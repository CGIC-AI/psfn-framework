function isSupportedIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep valid IANA timezone separators canonical for the strict Garden path
 * guard without decoding any other query field or malformed timezone.
 */
export function serializeModelUsageQuery(params: URLSearchParams): string {
  const serialized = params.toString();
  const timezone = params.get('timezone');
  if (!timezone?.includes('/') || !isSupportedIanaTimezone(timezone)) return serialized;
  const encodedTimezone = new URLSearchParams({ timezone }).toString();
  return serialized.replace(
    encodedTimezone,
    encodedTimezone.replaceAll('%2F', '/'),
  );
}

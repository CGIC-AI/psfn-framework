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
  return Array.from(params.entries(), ([key, value]) => {
    const encodedEntry = new URLSearchParams([[key, value]]).toString();
    if (
      key !== 'timezone'
      || !value.includes('/')
      || !isSupportedIanaTimezone(value)
    ) {
      return encodedEntry;
    }
    return encodedEntry.replaceAll('%2F', '/');
  }).join('&');
}

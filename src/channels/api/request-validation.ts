export function isPrimaryTrustLevelValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'primary';
}

export function hasCallerProvidedPrimaryTrust(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  if (isPrimaryTrustLevelValue(record.trustLevel) || isPrimaryTrustLevelValue(record.trust_level)) {
    return true;
  }

  const contact = record.contact;
  if (!contact || typeof contact !== 'object') return false;
  const contactRecord = contact as Record<string, unknown>;
  return isPrimaryTrustLevelValue(contactRecord.trustLevel)
    || isPrimaryTrustLevelValue(contactRecord.trust_level);
}

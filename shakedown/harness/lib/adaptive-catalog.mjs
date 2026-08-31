function responseDiagnostic(response) {
  if (typeof response?.fetchError === 'string' && response.fetchError.length > 0) {
    return response.fetchError;
  }
  const errorType = response?.body?.error?.type;
  if (typeof errorType === 'string' && errorType.length > 0) return errorType;
  try {
    return JSON.stringify(response?.body ?? null).slice(0, 400);
  } catch {
    return 'unserializable response';
  }
}

/**
 * Convert the sanctioned Garden adaptive-catalog response into its active tool
 * names. Authorization, transport, and shape failures are harness failures;
 * they must never masquerade as a valid empty catalog and skip every case.
 */
export function requireAdaptiveToolCatalog(response) {
  if (response?.ok !== true) {
    throw new Error(
      `adaptive tool catalog request failed with HTTP ${String(response?.status ?? 'unavailable')}: ${responseDiagnostic(response)}`,
    );
  }
  if (!Array.isArray(response?.body?.catalog?.tools)) {
    throw new Error('adaptive tool catalog response is missing catalog.tools');
  }
  return [...new Set(
    response.body.catalog.tools
      .map(tool => tool?.name)
      .filter(name => typeof name === 'string' && name.length > 0),
  )].sort();
}

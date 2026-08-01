import type { IntakeUrlSchemeAction } from '../../shared/contracts/intake-url-scanner.js';
import { isRecord } from '../../shared/utils/types.js';

export interface IntakeUrlScannerPolicyConfig {
  /**
   * Explicit treatment for URI schemes relevant to intake security. Schemes
   * omitted from this map stay silent; this avoids treating ordinary prose
   * containing an unfamiliar scheme as malicious.
   */
  schemeActions: Record<string, IntakeUrlSchemeAction>;
}

function invalid(sourcePath: string, detail: string): Error {
  return new Error(`Invalid intake policy at ${sourcePath}: ${detail}`);
}

export function validateIntakeUrlScannerPolicy(
  raw: unknown,
  sourcePath: string,
): IntakeUrlScannerPolicyConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'urlScanner must be an object');
  }
  const unknownKeys = Object.keys(raw).filter((key) => key !== 'schemeActions');
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `urlScanner has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (!isRecord(raw.schemeActions)) {
    throw invalid(sourcePath, 'urlScanner.schemeActions must be an object');
  }

  const schemeActions: Record<string, IntakeUrlSchemeAction> = {};
  let deniesAtLeastOneScheme = false;
  for (const [scheme, action] of Object.entries(raw.schemeActions)) {
    if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme)) {
      throw invalid(
        sourcePath,
        `urlScanner.schemeActions has invalid scheme '${scheme}' (lowercase URI scheme required)`,
      );
    }
    if (action !== 'allow' && action !== 'deny' && action !== 'deny_except_inline_image') {
      throw invalid(
        sourcePath,
        `urlScanner.schemeActions.${scheme} must be one of: allow, deny, deny_except_inline_image`,
      );
    }
    schemeActions[scheme] = action;
    if (action !== 'allow') deniesAtLeastOneScheme = true;
  }
  if (!deniesAtLeastOneScheme) {
    throw invalid(sourcePath, 'urlScanner.schemeActions must deny at least one scheme');
  }
  return { schemeActions };
}

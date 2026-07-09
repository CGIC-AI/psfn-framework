/**
 * Supply-chain advisory check for the deliberate dependency-update workflow.
 *
 * This module is intentionally free of process/git/IO side effects so its core
 * functions are importable and unit-testable. The thin CLI wrapper in
 * `scripts/verify-supply-chain.ts` supplies the lockfile text (git HEAD vs
 * working tree), the `fetch` implementation, and the process exit.
 *
 * Feed: OSV.dev batch query API (https://api.osv.dev/v1/querybatch). OSV is a
 * free, keyless aggregator that ingests the GitHub Advisory Database, so GHSA
 * ids surface directly in OSV responses — one API covers the "1-2 free feeds"
 * requirement (OSV.dev + GitHub Advisory Database via GHSA aliases).
 *
 * Fail closed: an update we could not verify is NOT a verified update. Any
 * network/API failure returns a nonzero result unless the caller passes
 * `allowOffline`, which downgrades to a loud warning.
 */

export const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
export const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns';
export const NPM_ECOSYSTEM = 'npm';

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface PackageRef {
  name: string;
  version: string;
}

export interface AdvisoryFinding {
  package: string;
  version: string;
  advisoryIds: string[];
  ghsaIds: string[];
  severity: string;
  summary: string;
  references: string[];
}

export type SupplyChainStatus =
  | 'no-changes'
  | 'clean'
  | 'hit'
  | 'offline-error'
  | 'offline-skipped';

export interface SupplyChainResult {
  status: SupplyChainStatus;
  exitCode: number;
  report: string;
  findings: AdvisoryFinding[];
  changedPackages: PackageRef[];
}

export interface CheckOptions {
  oldLockText: string;
  newLockText: string;
  fetchImpl: FetchLike;
  allowOffline?: boolean;
  requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse an npm lockfile (lockfileVersion 2/3, `packages` map) into a
 * name -> set-of-versions map. Only real installed npm packages are included:
 * entries under a `node_modules/` path with a concrete `version` and no `link`.
 * The root ("") and workspace link entries are intentionally excluded.
 */
export function parseLockfilePackages(text: string): Map<string, Set<string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Lockfile is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error('Lockfile root must be a JSON object.');
  }

  const packages = parsed.packages;
  if (!isRecord(packages)) {
    throw new Error(
      'Lockfile has no `packages` map. Only lockfileVersion 2/3 lockfiles are supported.',
    );
  }

  const result = new Map<string, Set<string>>();

  for (const [key, entry] of Object.entries(packages)) {
    const marker = 'node_modules/';
    const markerIndex = key.lastIndexOf(marker);
    if (markerIndex < 0) {
      // Root ("") or workspace path entry — not an installed npm package.
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.link === true) {
      continue;
    }
    const version = entry.version;
    if (typeof version !== 'string' || version.length === 0) {
      continue;
    }

    const name = key.slice(markerIndex + marker.length);
    if (name.length === 0) {
      continue;
    }

    let versions = result.get(name);
    if (!versions) {
      versions = new Set<string>();
      result.set(name, versions);
    }
    versions.add(version);
  }

  return result;
}

/**
 * Compute the (name, version) pairs that were ADDED or CHANGED between the old
 * lockfile and the new lockfile. A pair is included when the new lockfile pins
 * a version that the old lockfile did not have for that package name. Removed
 * packages and unchanged pairs are excluded (nothing new to scan).
 */
export function diffLockfiles(oldLockText: string, newLockText: string): PackageRef[] {
  const oldPackages = parseLockfilePackages(oldLockText);
  const newPackages = parseLockfilePackages(newLockText);

  const changed: PackageRef[] = [];

  for (const [name, versions] of newPackages) {
    const oldVersions = oldPackages.get(name);
    for (const version of versions) {
      if (!oldVersions || !oldVersions.has(version)) {
        changed.push({ name, version });
      }
    }
  }

  changed.sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
  return changed;
}

interface OsvVulnRef {
  id: string;
}

function extractVulnRefs(resultEntry: unknown): OsvVulnRef[] {
  if (!isRecord(resultEntry)) {
    return [];
  }
  const vulns = resultEntry.vulns;
  if (!Array.isArray(vulns)) {
    return [];
  }
  const refs: OsvVulnRef[] = [];
  for (const vuln of vulns) {
    if (isRecord(vuln) && typeof vuln.id === 'string' && vuln.id.length > 0) {
      refs.push({ id: vuln.id });
    }
  }
  return refs;
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `OSV request to ${url} failed: HTTP ${response.status} ${response.statusText ?? ''}`.trim(),
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query the OSV batch API for the given package/version pairs and return the
 * advisory refs per pair (index-aligned with the input). Throws on any network
 * or HTTP failure so the caller can fail closed.
 */
export async function queryOsvBatch(
  pairs: PackageRef[],
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<OsvVulnRef[][]> {
  if (pairs.length === 0) {
    return [];
  }

  const body = JSON.stringify({
    queries: pairs.map((pair) => ({
      package: { name: pair.name, ecosystem: NPM_ECOSYSTEM },
      version: pair.version,
    })),
  });

  const parsed = await fetchJson(
    fetchImpl,
    OSV_BATCH_URL,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body },
    timeoutMs,
  );

  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    throw new Error('OSV batch response missing `results` array.');
  }

  const results = parsed.results;
  if (results.length !== pairs.length) {
    throw new Error(
      `OSV batch response length (${results.length}) does not match query count (${pairs.length}).`,
    );
  }

  return results.map((entry) => extractVulnRefs(entry));
}

interface OsvVulnDetails {
  advisoryIds: string[];
  ghsaIds: string[];
  severity: string;
  summary: string;
  references: string[];
}

function normalizeVulnDetails(vulnId: string, raw: unknown): OsvVulnDetails {
  const advisoryIds = new Set<string>();
  const ghsaIds = new Set<string>();
  let severity = 'unknown';
  let summary = '';
  const references: string[] = [];

  const addId = (candidate: unknown): void => {
    if (typeof candidate === 'string' && candidate.length > 0) {
      advisoryIds.add(candidate);
      if (candidate.startsWith('GHSA-')) {
        ghsaIds.add(candidate);
      }
    }
  };

  addId(vulnId);

  if (isRecord(raw)) {
    if (Array.isArray(raw.aliases)) {
      for (const alias of raw.aliases) {
        addId(alias);
      }
    }
    if (typeof raw.summary === 'string' && raw.summary.length > 0) {
      summary = raw.summary;
    } else if (typeof raw.details === 'string' && raw.details.length > 0) {
      summary = raw.details.split('\n')[0]?.slice(0, 240) ?? '';
    }

    // Severity: prefer database_specific.severity (GHSA-style label), then
    // the CVSS score(s) in the severity array.
    if (
      isRecord(raw.database_specific) &&
      typeof raw.database_specific.severity === 'string'
    ) {
      severity = raw.database_specific.severity;
    } else if (Array.isArray(raw.severity)) {
      const scores = raw.severity
        .filter(isRecord)
        .map((entry) => (typeof entry.score === 'string' ? entry.score : null))
        .filter((score): score is string => score !== null);
      if (scores.length > 0) {
        severity = scores.join(', ');
      }
    }

    if (Array.isArray(raw.references)) {
      for (const reference of raw.references) {
        if (isRecord(reference) && typeof reference.url === 'string' && reference.url.length > 0) {
          references.push(reference.url);
        }
      }
    }
  }

  return {
    advisoryIds: [...advisoryIds],
    ghsaIds: [...ghsaIds],
    severity,
    summary,
    references,
  };
}

async function fetchVulnDetails(
  vulnId: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<OsvVulnDetails> {
  const parsed = await fetchJson(
    fetchImpl,
    `${OSV_VULN_URL}/${encodeURIComponent(vulnId)}`,
    { method: 'GET', headers: { accept: 'application/json' } },
    timeoutMs,
  );
  return normalizeVulnDetails(vulnId, parsed);
}

function formatReport(findings: AdvisoryFinding[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('==================================================================');
  lines.push('  SUPPLY-CHAIN ADVISORY HIT — DEPENDENCY UPDATE BLOCKED');
  lines.push('==================================================================');
  lines.push('');
  lines.push(
    `${findings.length} changed/added package version(s) match a published security advisory (OSV.dev / GitHub Advisory Database).`,
  );
  lines.push('Do NOT commit this lockfile change. Pin to a safe version and re-run the check.');
  lines.push('');

  for (const finding of findings) {
    lines.push(`  x ${finding.package}@${finding.version}`);
    lines.push(`      advisories: ${finding.advisoryIds.join(', ')}`);
    if (finding.ghsaIds.length > 0) {
      lines.push(`      GHSA:       ${finding.ghsaIds.join(', ')}`);
    }
    lines.push(`      severity:   ${finding.severity}`);
    if (finding.summary) {
      lines.push(`      summary:    ${finding.summary}`);
    }
    if (finding.references.length > 0) {
      lines.push('      references:');
      for (const reference of finding.references) {
        lines.push(`        - ${reference}`);
      }
    }
    lines.push('');
  }

  lines.push('==================================================================');
  return lines.join('\n');
}

/**
 * Orchestrate the full check: diff lockfiles, query OSV for changed pairs,
 * enrich hits with advisory detail, and build a report + exit code.
 *
 * Fail-closed contract: any network/API failure returns `offline-error`
 * (exit 1) unless `allowOffline` is set, which returns `offline-skipped`
 * (exit 0) with a prominent warning baked into the report string.
 */
export async function checkSupplyChain(options: CheckOptions): Promise<SupplyChainResult> {
  const timeoutMs = options.requestTimeoutMs ?? 20_000;
  const changedPackages = diffLockfiles(options.oldLockText, options.newLockText);

  if (changedPackages.length === 0) {
    return {
      status: 'no-changes',
      exitCode: 0,
      report:
        'No dependency changes detected between HEAD and the working-tree lockfile. Nothing to verify.',
      findings: [],
      changedPackages: [],
    };
  }

  let perPairVulns: OsvVulnRef[][];
  const detailsById = new Map<string, OsvVulnDetails>();
  try {
    perPairVulns = await queryOsvBatch(changedPackages, options.fetchImpl, timeoutMs);

    const uniqueIds = new Set<string>();
    for (const refs of perPairVulns) {
      for (const ref of refs) {
        uniqueIds.add(ref.id);
      }
    }
    for (const id of uniqueIds) {
      detailsById.set(id, await fetchVulnDetails(id, options.fetchImpl, timeoutMs));
    }
  } catch (error) {
    const message = `Could not verify ${changedPackages.length} changed package(s) against OSV.dev: ${
      error instanceof Error ? error.message : String(error)
    }`;
    if (options.allowOffline) {
      const warning = [
        '',
        '******************************************************************',
        '  WARNING: SUPPLY-CHAIN CHECK SKIPPED (--allow-offline)',
        '******************************************************************',
        `  ${message}`,
        '  This update has NOT been verified against advisory feeds.',
        '  Only acceptable when you have independently confirmed the feed',
        '  outage and accept the risk. Re-run without --allow-offline once',
        '  connectivity is restored.',
        '******************************************************************',
        '',
      ].join('\n');
      return {
        status: 'offline-skipped',
        exitCode: 0,
        report: warning,
        findings: [],
        changedPackages,
      };
    }
    return {
      status: 'offline-error',
      exitCode: 1,
      report: [
        '',
        'SUPPLY-CHAIN CHECK FAILED CLOSED — could not reach advisory feed.',
        `  ${message}`,
        '  An unverifiable update is not a verified update.',
        '  Fix connectivity and re-run, or pass --allow-offline to override with a documented risk acceptance.',
        '',
      ].join('\n'),
      findings: [],
      changedPackages,
    };
  }

  const findings: AdvisoryFinding[] = [];
  for (let index = 0; index < changedPackages.length; index += 1) {
    const pair = changedPackages[index];
    const refs = perPairVulns[index] ?? [];
    if (refs.length === 0) {
      continue;
    }
    const advisoryIds = new Set<string>();
    const ghsaIds = new Set<string>();
    const references = new Set<string>();
    const severities: string[] = [];
    const summaries: string[] = [];
    for (const ref of refs) {
      const details = detailsById.get(ref.id);
      if (!details) {
        advisoryIds.add(ref.id);
        continue;
      }
      for (const id of details.advisoryIds) advisoryIds.add(id);
      for (const id of details.ghsaIds) ghsaIds.add(id);
      for (const url of details.references) references.add(url);
      if (details.severity && details.severity !== 'unknown') severities.push(details.severity);
      if (details.summary) summaries.push(details.summary);
    }
    findings.push({
      package: pair.name,
      version: pair.version,
      advisoryIds: [...advisoryIds],
      ghsaIds: [...ghsaIds],
      severity: severities.length > 0 ? [...new Set(severities)].join('; ') : 'unknown',
      summary: summaries.length > 0 ? [...new Set(summaries)].join(' | ') : '',
      references: [...references],
    });
  }

  if (findings.length === 0) {
    return {
      status: 'clean',
      exitCode: 0,
      report: `Verified ${changedPackages.length} changed/added package version(s) against OSV.dev — no known advisories.`,
      findings: [],
      changedPackages,
    };
  }

  return {
    status: 'hit',
    exitCode: 1,
    report: formatReport(findings),
    findings,
    changedPackages,
  };
}

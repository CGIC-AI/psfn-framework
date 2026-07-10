import { describe, expect, it } from 'vitest';
import {
  checkSupplyChain,
  diffLockfiles,
  parseLockfilePackages,
  type FetchLike,
} from './supply-chain-check.js';

interface LockPkg {
  name: string;
  version: string;
  scoped?: boolean;
  nested?: boolean;
  link?: boolean;
}

function makeLockfile(packages: LockPkg[]): string {
  const packagesMap: Record<string, unknown> = {
    '': { name: 'psfn-framework', version: '0.1.0' },
    'admin-ui': { version: '0.0.0', link: true },
  };
  for (const pkg of packages) {
    const key = pkg.nested
      ? `node_modules/host/node_modules/${pkg.name}`
      : `node_modules/${pkg.name}`;
    const entry: Record<string, unknown> = { version: pkg.version };
    if (pkg.link) {
      entry.link = true;
    }
    packagesMap[key] = entry;
  }
  return JSON.stringify({ name: 'psfn-framework', lockfileVersion: 3, packages: packagesMap });
}

// A mock OSV backend keyed on package name+version. Returns a batch response
// index-aligned with the posted queries, and per-vuln detail for known ids.
function makeOsvFetch(config: {
  hits: Record<string, { id: string; detail: unknown }>;
  failBatch?: boolean;
  failDetail?: boolean;
}): FetchLike {
  return async (url, init) => {
    if (url.includes('/v1/querybatch')) {
      if (config.failBatch) {
        throw new Error('network down');
      }
      const body = JSON.parse(init?.body ?? '{}') as {
        queries: Array<{ package: { name: string }; version: string }>;
      };
      const results = body.queries.map((query) => {
        const hit = config.hits[`${query.package.name}@${query.version}`];
        return hit ? { vulns: [{ id: hit.id }] } : {};
      });
      return okJson({ results });
    }
    if (url.includes('/v1/vulns/')) {
      if (config.failDetail) {
        return { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}), text: async () => '' };
      }
      const id = decodeURIComponent(url.split('/v1/vulns/')[1] ?? '');
      const match = Object.values(config.hits).find((hit) => hit.id === id);
      return okJson(match?.detail ?? {});
    }
    throw new Error(`unexpected url ${url}`);
  };
}

function okJson(value: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

// Shape modeled on a real historical advisory: event-stream@3.3.6 backdoor.
const EVENT_STREAM_ADVISORY = {
  id: 'GHSA-mh6f-8j2x-4483',
  aliases: ['CVE-2018-16487'],
  summary: 'Malicious code in event-stream (flatmap-stream backdoor)',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
  database_specific: { severity: 'CRITICAL' },
  references: [
    { type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-mh6f-8j2x-4483' },
    { type: 'WEB', url: 'https://github.com/dominictarr/event-stream/issues/116' },
  ],
};

describe('parseLockfilePackages', () => {
  it('extracts installed npm packages and skips root + linked workspace entries', () => {
    const map = parseLockfilePackages(
      makeLockfile([
        { name: 'left-pad', version: '1.3.0' },
        { name: '@scope/thing', version: '2.0.0' },
        { name: 'linked-local', version: '9.9.9', link: true },
      ]),
    );
    expect(map.get('left-pad')).toEqual(new Set(['1.3.0']));
    expect(map.get('@scope/thing')).toEqual(new Set(['2.0.0']));
    // linked workspace + root are excluded
    expect(map.has('linked-local')).toBe(false);
    expect(map.has('admin-ui')).toBe(false);
    expect(map.has('')).toBe(false);
  });

  it('uses the last node_modules segment as the package name for nested deps', () => {
    const map = parseLockfilePackages(
      makeLockfile([{ name: 'nested-dep', version: '4.5.6', nested: true }]),
    );
    expect(map.get('nested-dep')).toEqual(new Set(['4.5.6']));
  });

  it('throws on invalid JSON (fail closed, no swallow)', () => {
    expect(() => parseLockfilePackages('{not json')).toThrow(/not valid JSON/);
  });

  it('throws when the packages map is absent', () => {
    expect(() => parseLockfilePackages(JSON.stringify({ lockfileVersion: 1 }))).toThrow(
      /no `packages` map/,
    );
  });
});

describe('diffLockfiles', () => {
  const base = makeLockfile([
    { name: 'keep-me', version: '1.0.0' },
    { name: 'bump-me', version: '1.0.0' },
    { name: 'remove-me', version: '1.0.0' },
  ]);

  it('flags version bumps and new deps, ignores unchanged and removed', () => {
    const next = makeLockfile([
      { name: 'keep-me', version: '1.0.0' }, // unchanged
      { name: 'bump-me', version: '2.0.0' }, // version bump
      { name: 'brand-new', version: '0.1.0' }, // added
      // remove-me dropped
    ]);
    const changed = diffLockfiles(base, next);
    expect(changed).toEqual([
      { name: 'brand-new', version: '0.1.0' },
      { name: 'bump-me', version: '2.0.0' },
    ]);
  });

  it('returns empty when lockfiles are identical', () => {
    expect(diffLockfiles(base, base)).toEqual([]);
  });
});

describe('checkSupplyChain', () => {
  const clean = makeLockfile([{ name: 'safe-pkg', version: '1.0.0' }]);

  it('exits 0 with a no-changes note when nothing changed', async () => {
    const result = await checkSupplyChain({
      oldLockText: clean,
      newLockText: clean,
      fetchImpl: makeOsvFetch({ hits: {} }),
    });
    expect(result.status).toBe('no-changes');
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatch(/No dependency changes/);
  });

  it('exits 0 when changed packages have no advisories', async () => {
    const next = makeLockfile([
      { name: 'safe-pkg', version: '1.0.0' },
      { name: 'another-safe', version: '3.2.1' },
    ]);
    const result = await checkSupplyChain({
      oldLockText: clean,
      newLockText: next,
      fetchImpl: makeOsvFetch({ hits: {} }),
    });
    expect(result.status).toBe('clean');
    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it('demonstrably flags a known-bad package version (event-stream@3.3.6) and exits nonzero', async () => {
    const next = makeLockfile([
      { name: 'safe-pkg', version: '1.0.0' },
      { name: 'event-stream', version: '3.3.6' },
    ]);
    const result = await checkSupplyChain({
      oldLockText: clean,
      newLockText: next,
      fetchImpl: makeOsvFetch({
        hits: {
          'event-stream@3.3.6': { id: 'GHSA-mh6f-8j2x-4483', detail: EVENT_STREAM_ADVISORY },
        },
      }),
    });

    expect(result.status).toBe('hit');
    expect(result.exitCode).toBe(1);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding.package).toBe('event-stream');
    expect(finding.version).toBe('3.3.6');
    expect(finding.ghsaIds).toContain('GHSA-mh6f-8j2x-4483');
    expect(finding.advisoryIds).toContain('CVE-2018-16487');
    expect(finding.severity).toBe('CRITICAL');

    // The loud human-readable report names the package, version, and advisory.
    expect(result.report).toContain('event-stream@3.3.6');
    expect(result.report).toContain('GHSA-mh6f-8j2x-4483');
    expect(result.report).toContain('BLOCKED');
    expect(result.report).toContain('https://github.com/advisories/GHSA-mh6f-8j2x-4483');
  });

  it('fails closed (exit 1) when the OSV feed is unreachable', async () => {
    const next = makeLockfile([{ name: 'event-stream', version: '3.3.6' }]);
    const result = await checkSupplyChain({
      oldLockText: clean,
      newLockText: next,
      fetchImpl: makeOsvFetch({ hits: {}, failBatch: true }),
    });
    expect(result.status).toBe('offline-error');
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/FAILED CLOSED/);
  });

  it('fails closed (exit 1) when advisory detail enrichment errors', async () => {
    const next = makeLockfile([{ name: 'event-stream', version: '3.3.6' }]);
    const result = await checkSupplyChain({
      oldLockText: clean,
      newLockText: next,
      fetchImpl: makeOsvFetch({
        hits: {
          'event-stream@3.3.6': { id: 'GHSA-mh6f-8j2x-4483', detail: EVENT_STREAM_ADVISORY },
        },
        failDetail: true,
      }),
    });
    expect(result.status).toBe('offline-error');
    expect(result.exitCode).toBe(1);
  });

  it('downgrades a feed outage to exit 0 with a loud warning under --allow-offline', async () => {
    const next = makeLockfile([{ name: 'event-stream', version: '3.3.6' }]);
    const result = await checkSupplyChain({
      oldLockText: clean,
      newLockText: next,
      fetchImpl: makeOsvFetch({ hits: {}, failBatch: true }),
      allowOffline: true,
    });
    expect(result.status).toBe('offline-skipped');
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatch(/WARNING: SUPPLY-CHAIN CHECK SKIPPED/);
    expect(result.report).toMatch(/NOT been verified/);
  });
});

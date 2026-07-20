// Shadow-only enforcement (docs/partner-affect.md slice 1, psfn-framework-qeid).
//
// The Partner Affect observation foundation must be unreachable as behavioral
// authority: nothing in prompt assembly, session/context recording, emotion
// appraisal, memory candidacy, intention/scheduling, or world-action code may
// import the shadow surfaces. This test walks the source tree and fails when
// a new importer appears outside the reviewed allowlist, so any future wiring
// into a behavioral path is a deliberate, visible decision.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

/** Import specifiers that identify the partner-affect shadow surfaces. */
const SHADOW_SPECIFIER_PATTERN = /partner-affect(?:-shadow)?/;

/**
 * Reviewed importers. Ingest spine, persistence wiring, canonical config,
 * Garden inspection surface, and the module family itself — nothing else.
 */
const ALLOWED_IMPORTERS: ReadonlySet<string> = new Set([
  // Module family (contracts, guard, estimate, bridge, store port) + tests.
  'src/core/emotion/partner-affect/observation-guard.ts',
  'src/core/emotion/partner-affect/observation-guard.test.ts',
  'src/core/emotion/partner-affect/shadow-estimate.ts',
  'src/core/emotion/partner-affect/shadow-estimate.test.ts',
  'src/core/emotion/partner-affect/shadow-ingest-bridge.ts',
  'src/core/emotion/partner-affect/shadow-ingest-bridge.test.ts',
  'src/core/emotion/partner-affect/shadow-store-port.ts',
  // Typed event spine (telemetry counter payload type only).
  'src/shared/event-bus.ts',
  // API-channel telemetry allowlist (event-type constant only).
  'src/channels/api/server.ts',
  // Postgres persistence + factory wiring.
  'src/persistence/postgres/partner-affect-shadow-store.ts',
  'src/persistence/postgres/partner-affect-shadow-store.integration.test.ts',
  'src/persistence/runtime-factory.ts',
  'src/persistence/runtime-factory.test.ts',
  // Canonical JSON-owned settings registration.
  'src/system/config/partner-affect-shadow-config.ts',
  'src/system/config/partner-affect-shadow-config.test.ts',
  'src/system/config/config-store.ts',
  'src/system/config/settings-contract.ts',
  'src/system/config/startup-owner-files.ts',
  // Agent entrypoint wiring (bridge creation + shutdown only).
  'src/app/agent/main.ts',
  'src/app/agent/admin-surface.ts',
  // Garden read-only inspection surface.
  'src/operator/garden/admin-contract.ts',
  'src/operator/garden/local-admin-contract.ts',
  'src/operator/garden/api-routes.ts',
  'src/operator/garden/routes/partner-affect-shadow-routes.ts',
  'src/operator/garden/services/partner-affect-shadow-service.ts',
  'src/operator/garden/services/partner-affect-shadow-service.test.ts',
]);

/**
 * Behavioral subsystems that must never consume shadow output. Subset of the
 * allowlist rule above, asserted separately so the intent survives allowlist
 * edits.
 */
const FORBIDDEN_PREFIXES = [
  'src/core/session/',
  'src/core/prompts/',
  'src/core/identity/',
  'src/core/intention/',
  'src/core/scheduler/',
  'src/core/self-model/',
  'src/core/agent/',
  'src/faculties/',
];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function findShadowImporters(): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  const importPattern = /(?:from|import|require\()\s*['"]([^'"]+)['"]/g;
  for (const file of listSourceFiles(SRC_ROOT)) {
    const relativePath = relative(process.cwd(), file).split(sep).join('/');
    // The contracts module defines the surface; it is not an importer of it.
    if (relativePath === 'src/shared/contracts/partner-affect.ts') continue;
    if (relativePath === 'src/core/emotion/partner-affect/shadow-isolation.test.ts') continue;
    const content = readFileSync(file, 'utf8');
    const matched: string[] = [];
    for (const match of content.matchAll(importPattern)) {
      if (SHADOW_SPECIFIER_PATTERN.test(match[1])) {
        matched.push(match[1]);
      }
    }
    if (matched.length > 0) {
      importers.set(relativePath, matched);
    }
  }
  return importers;
}

describe('partner-affect shadow isolation', () => {
  it('is imported only by the reviewed ingest/persistence/config/Garden allowlist', () => {
    const importers = findShadowImporters();
    const unexpected = [...importers.keys()].filter(path => !ALLOWED_IMPORTERS.has(path));
    expect(
      unexpected,
      `Partner-affect shadow surfaces gained importers outside the reviewed allowlist: ${unexpected.join(', ')}. `
      + 'Shadow output must stay unreachable as behavioral authority (docs/partner-affect.md section 17); '
      + 'wiring it into a new consumer requires deliberate review of this test.',
    ).toEqual([]);
  });

  it('is never imported by prompts, session, memory, appraisal, intention, scheduler, or agent runtime code', () => {
    const importers = findShadowImporters();
    const behavioral = [...importers.keys()].filter(
      path => FORBIDDEN_PREFIXES.some(prefix => path.startsWith(prefix)),
    );
    expect(behavioral).toEqual([]);
  });

  it('keeps the ingest spine wired: the agent entrypoint creates the shadow bridge', () => {
    // The inverse guarantee: shadow-only must not degrade into dead code. The
    // production agent entrypoint must instantiate the bridge and the store.
    const mainSource = readFileSync(join(SRC_ROOT, 'app/agent/main.ts'), 'utf8');
    expect(mainSource).toContain('createPartnerAffectShadowIngestBridge');
    expect(mainSource).toContain('loadPartnerAffectShadowConfig');
    const factorySource = readFileSync(join(SRC_ROOT, 'persistence/runtime-factory.ts'), 'utf8');
    expect(factorySource).toContain('PostgresPartnerAffectShadowStore.connect');
  });
});

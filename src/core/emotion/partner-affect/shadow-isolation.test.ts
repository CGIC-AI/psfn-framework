// Shadow-only enforcement (docs/partner-affect.md slice 1).
//
// The Partner Affect observation foundation must be unreachable as behavioral
// authority: nothing in prompt assembly, session/context recording, emotion
// appraisal, memory candidacy, intention/scheduling, or world-action code may
// import the shadow surfaces. This test walks the source tree and fails when
// a new importer appears outside the reviewed allowlist, so any future wiring
// into a behavioral path is a deliberate, visible decision.
//
// Two escape hatches beyond a plain module-import graph are covered explicitly:
//   1. A behavioral consumer could reach shadow output via the event bus
//      instead of an import — by subscribing (string literal) to the shadow
//      telemetry event. The third test scans for that literal and holds it to
//      the same allowlist.
//   2. A consumer could read the Postgres shadow tables directly. The fourth
//      test scans for those table names outside the persistence/config layer.
// Limitation (not overclaimed): these are static source scans. A subscription
// assembled from a dynamically-computed event name, or a raw SQL string built
// at runtime, would evade them; such indirection would itself be a reviewable
// anomaly in this codebase, which uses literal event names and table names.

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
  // Additive owner migration validates/seeds the canonical config only.
  'src/system/config/required-owner-additions-migration.ts',
  'src/system/config/required-owner-additions-migration.test.ts',
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

  it('has no behavioral subscriber to the shadow telemetry event outside the allowlist', () => {
    // A consumer could reach shadow output via the bus rather than an import.
    // Only the bridge (emitter), the event-bus type map, and tests may name the
    // shadow telemetry event; any other file referencing it — especially a
    // `.on(...)` subscriber — would be an undeclared behavioral tap.
    const EVENT_LITERAL = 'emotion.partner_affect.shadow.telemetry';
    const allowed = new Set([
      'src/core/emotion/partner-affect/shadow-ingest-bridge.ts',
      'src/core/emotion/partner-affect/shadow-ingest-bridge.test.ts',
      'src/shared/event-bus.ts',
      'src/core/emotion/partner-affect/shadow-isolation.test.ts',
    ]);
    const referrers: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const relativePath = relative(process.cwd(), file).split(sep).join('/');
      if (allowed.has(relativePath)) continue;
      if (readFileSync(file, 'utf8').includes(EVENT_LITERAL)) {
        referrers.push(relativePath);
      }
    }
    expect(
      referrers,
      `Undeclared reference to the shadow telemetry event: ${referrers.join(', ')}. `
      + 'A bus subscriber to this event is a behavioral tap on shadow output and must be reviewed.',
    ).toEqual([]);
  });

  it('reads the Postgres shadow tables only from the persistence layer', () => {
    // A consumer could bypass the store port and read the tables directly.
    const TABLE_NAMES = [
      'partner_affect_shadow_observations',
      'partner_affect_shadow_suppressions',
    ];
    const allowed = new Set([
      'src/persistence/postgres/partner-affect-shadow-store.ts',
      'src/persistence/postgres/partner-affect-shadow-store.integration.test.ts',
      'src/persistence/postgres/migrations.ts',
      'src/persistence/postgres/migrations.test.ts',
      'src/core/emotion/partner-affect/shadow-isolation.test.ts',
    ]);
    const referrers: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const relativePath = relative(process.cwd(), file).split(sep).join('/');
      if (allowed.has(relativePath)) continue;
      const content = readFileSync(file, 'utf8');
      if (TABLE_NAMES.some(table => content.includes(table))) {
        referrers.push(relativePath);
      }
    }
    expect(referrers).toEqual([]);
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

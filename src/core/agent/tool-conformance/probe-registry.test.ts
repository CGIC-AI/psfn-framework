import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listCanonicalToolSurfaces } from '../tool-surface/registry.js';
import {
  TOOL_CONFORMANCE_PROBE_REGISTRY,
  TOOL_CONFORMANCE_ACTION_REGISTRY,
  TOOL_CONFORMANCE_INTERNAL_CHANNEL,
} from './probe-registry.js';

// Actions that must NEVER be classified as read_only.
const MUTATING_ACTION_HINTS = [
  'write', 'create', 'update', 'delete', 'remove', 'send', 'restart', 'rebuild',
  'exec', 'spawn', 'generate', 'edit', 'commit', 'patch', 'publish', 'import',
  'pin', 'unpin', 'activate', 'redact', 'restore', 'no_reply',
];

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('tool conformance probe registry coverage', () => {
  it('classifies every canonical first-party tool (fails when a new tool is unclassified)', () => {
    const missing = listCanonicalToolSurfaces()
      .map(surface => surface.name)
      .filter(name => !Object.prototype.hasOwnProperty.call(TOOL_CONFORMANCE_PROBE_REGISTRY, name));
    expect(missing, `unclassified canonical tools: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale entries pointing at non-canonical tool names', () => {
    const canonical = new Set(listCanonicalToolSurfaces().map(surface => surface.name));
    const stale = Object.keys(TOOL_CONFORMANCE_PROBE_REGISTRY).filter(name => !canonical.has(name));
    expect(stale, `stale probe registry entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('does not classify an unregistered shard tool as model-facing', () => {
    expect(TOOL_CONFORMANCE_PROBE_REGISTRY).not.toHaveProperty('shard');
  });

  it('keeps exactly one SubagentExecutionPort definition on the SubagentFaculty path', () => {
    const definitions = listTypeScriptFiles(resolve('src'))
      .filter((path) => /export\s+interface\s+SubagentExecutionPort\b/u.test(readFileSync(path, 'utf-8')))
      .map((path) => relative(process.cwd(), path))
      .sort();

    expect(definitions).toEqual(['src/faculties/subagents/port.ts']);
  });

  it('never classifies a mutating action as read_only', () => {
    for (const [name, spec] of Object.entries(TOOL_CONFORMANCE_PROBE_REGISTRY)) {
      if (spec.kind !== 'read_only') continue;
      const action = spec.action ?? '';
      expect(
        MUTATING_ACTION_HINTS.includes(action),
        `${name} read_only probe uses mutating action "${action}"`,
      ).toBe(false);
    }
  });
});

describe('tool conformance per-action registry coverage (bead 65rk.7)', () => {
  const actionAwareSurfaces = listCanonicalToolSurfaces()
    .filter(surface => (surface.actions?.length ?? 0) > 0);

  it('classifies every canonical action of every action-aware tool (fails closed on a new verb)', () => {
    const missing: string[] = [];
    for (const surface of actionAwareSurfaces) {
      const classified = TOOL_CONFORMANCE_ACTION_REGISTRY[surface.name] ?? {};
      for (const action of surface.actions ?? []) {
        if (!Object.prototype.hasOwnProperty.call(classified, action)) {
          missing.push(`${surface.name}.${action}`);
        }
      }
    }
    expect(missing, `unclassified canonical actions: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale action entries pointing at non-canonical tool/action names', () => {
    const canonicalActions = new Map(
      listCanonicalToolSurfaces().map(surface => [surface.name, new Set(surface.actions ?? [])]),
    );
    const stale: string[] = [];
    for (const [toolName, actions] of Object.entries(TOOL_CONFORMANCE_ACTION_REGISTRY)) {
      const canonical = canonicalActions.get(toolName);
      if (!canonical) {
        stale.push(`${toolName} (not a canonical tool)`);
        continue;
      }
      for (const action of Object.keys(actions)) {
        if (!canonical.has(action)) stale.push(`${toolName}.${action}`);
      }
    }
    expect(stale, `stale action registry entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('does not register action entries for action-less tools', () => {
    const actionLess = listCanonicalToolSurfaces()
      .filter(surface => (surface.actions?.length ?? 0) === 0)
      .map(surface => surface.name);
    for (const name of actionLess) {
      expect(TOOL_CONFORMANCE_ACTION_REGISTRY, `${name} is action-less and must not carry action probes`)
        .not.toHaveProperty(name);
    }
  });

  it('classifies every action as exactly one of safe_read / scoped_mutation / schema_assert', () => {
    for (const [toolName, actions] of Object.entries(TOOL_CONFORMANCE_ACTION_REGISTRY)) {
      for (const [action, spec] of Object.entries(actions)) {
        expect(['safe_read', 'scoped_mutation', 'schema_assert'], `${toolName}.${action}`).toContain(spec.kind);
      }
    }
  });

  it('never classifies a mutating verb as safe_read', () => {
    for (const [toolName, actions] of Object.entries(TOOL_CONFORMANCE_ACTION_REGISTRY)) {
      for (const [action, spec] of Object.entries(actions)) {
        if (spec.kind !== 'safe_read') continue;
        expect(
          MUTATING_ACTION_HINTS.includes(action),
          `${toolName}.${action} safe_read probe uses a mutating verb`,
        ).toBe(false);
        // The dispatched action must match the classified action key.
        expect((spec.args as { action?: unknown }).action, `${toolName}.${action} safe_read args.action mismatch`)
          .toBe(action);
      }
    }
  });

  it('gives every scoped_mutation a cleanup teardown scoped to the internal channel', () => {
    for (const [toolName, actions] of Object.entries(TOOL_CONFORMANCE_ACTION_REGISTRY)) {
      for (const [action, spec] of Object.entries(actions)) {
        if (spec.kind !== 'scoped_mutation') continue;
        expect(spec.cleanup.args, `${toolName}.${action} scoped_mutation missing cleanup`).toBeDefined();
        expect(
          (spec.args as { channel_id?: unknown }).channel_id,
          `${toolName}.${action} scoped_mutation must target the internal:tool-conformance channel`,
        ).toBe(TOOL_CONFORMANCE_INTERNAL_CHANNEL);
      }
    }
  });
});

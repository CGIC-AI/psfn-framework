import { describe, expect, it } from 'vitest';
import { listCanonicalToolSurfaces } from '../tool-surface/registry.js';
import { TOOL_CONFORMANCE_PROBE_REGISTRY } from './probe-registry.js';

// Actions that must NEVER be classified as read_only.
const MUTATING_ACTION_HINTS = [
  'write', 'create', 'update', 'delete', 'remove', 'send', 'restart', 'rebuild',
  'exec', 'spawn', 'generate', 'edit', 'commit', 'patch', 'publish', 'import',
  'pin', 'unpin', 'activate', 'redact', 'restore', 'no_reply',
];

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

import { describe, expect, it } from 'vitest';
import {
  createEmptySubagentRoleRegistryConfig,
  layerRoleSystemPrompt,
  parseSubagentRoleRegistryConfig,
  resolveSubagentRole,
  type ResolvedSubagentRole,
} from './role-registry.js';

const VALID_REGISTRY = {
  roles: {
    researcher: {
      instructions: 'Gather and synthesize information.',
      capabilities: ['general'],
      maxTurns: 6,
      timeoutMs: 300000,
      maxConcurrent: 3,
    },
    observer: {
      instructions: 'Watch and describe without acting.',
      inheritIdentity: false,
      allowedTools: ['memory'],
    },
  },
};

describe('parseSubagentRoleRegistryConfig', () => {
  it('parses a well-formed registry and freezes it', () => {
    const parsed = parseSubagentRoleRegistryConfig(VALID_REGISTRY, 'subagent-roles.json');
    expect(Object.keys(parsed.roles).sort()).toEqual(['observer', 'researcher']);
    expect(parsed.roles.researcher.maxTurns).toBe(6);
    expect(parsed.roles.observer.inheritIdentity).toBe(false);
    expect(parsed.roles.observer.allowedTools).toEqual(['memory']);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.roles)).toBe(true);
  });

  it('treats an absent registry as the empty registry (feature unconfigured)', () => {
    expect(parseSubagentRoleRegistryConfig(undefined, 'p').roles).toEqual({});
    expect(parseSubagentRoleRegistryConfig(null, 'p').roles).toEqual({});
    expect(parseSubagentRoleRegistryConfig({}, 'p').roles).toEqual({});
  });

  it('fails closed on a non-object registry', () => {
    expect(() => parseSubagentRoleRegistryConfig(42, 'p')).toThrow(/registry object/);
  });

  it('fails closed on unknown top-level keys', () => {
    expect(() => parseSubagentRoleRegistryConfig({ roles: {}, bogus: 1 }, 'p'))
      .toThrow(/unknown keys: bogus/);
  });

  it('fails closed on a role with missing/blank instructions', () => {
    expect(() => parseSubagentRoleRegistryConfig({ roles: { r: {} } }, 'p'))
      .toThrow(/instructions must be a non-empty string/);
    expect(() => parseSubagentRoleRegistryConfig({ roles: { r: { instructions: '   ' } } }, 'p'))
      .toThrow(/instructions must be a non-empty string/);
  });

  it('fails closed on an unknown key inside a role definition', () => {
    expect(() => parseSubagentRoleRegistryConfig(
      { roles: { r: { instructions: 'x', widen: true } } },
      'p',
    )).toThrow(/roles\.r has unknown keys: widen/);
  });

  it('fails closed on a non-integer or out-of-range maxTurns', () => {
    expect(() => parseSubagentRoleRegistryConfig(
      { roles: { r: { instructions: 'x', maxTurns: 0 } } },
      'p',
    )).toThrow(/maxTurns must be >= 1/);
    expect(() => parseSubagentRoleRegistryConfig(
      { roles: { r: { instructions: 'x', maxTurns: 1.5 } } },
      'p',
    )).toThrow(/maxTurns must be an integer/);
  });

  it('fails closed on a role name key carrying surrounding whitespace', () => {
    expect(() => parseSubagentRoleRegistryConfig(
      { roles: { ' spaced ': { instructions: 'x' } } },
      'p',
    )).toThrow(/must not carry surrounding whitespace/);
  });

  it('fails closed on non-string allowedTools/capabilities entries', () => {
    expect(() => parseSubagentRoleRegistryConfig(
      { roles: { r: { instructions: 'x', allowedTools: ['ok', 3] } } },
      'p',
    )).toThrow(/allowedTools\[1\] must be a string/);
  });
});

describe('resolveSubagentRole', () => {
  const registry = parseSubagentRoleRegistryConfig(VALID_REGISTRY, 'p');

  it('resolves a known role', () => {
    const resolved = resolveSubagentRole(registry, 'researcher');
    expect(resolved.name).toBe('researcher');
    expect(resolved.definition.maxTurns).toBe(6);
  });

  it('fails closed on an unknown role and surfaces the known set', () => {
    expect(() => resolveSubagentRole(registry, 'saboteur'))
      .toThrow(/Unknown subagent role "saboteur"\. Known roles: observer, researcher\./);
  });

  it('fails closed on an unknown role against an empty registry', () => {
    expect(() => resolveSubagentRole(createEmptySubagentRoleRegistryConfig(), 'researcher'))
      .toThrow(/No subagent roles are configured/);
    expect(() => resolveSubagentRole(undefined, 'researcher'))
      .toThrow(/No subagent roles are configured/);
  });

  it('fails closed on a blank role name', () => {
    expect(() => resolveSubagentRole(registry, '   ')).toThrow(/non-empty string/);
  });
});

describe('layerRoleSystemPrompt', () => {
  const parent = 'You are Companion, warm and precise.';
  function role(overrides: Partial<ResolvedSubagentRole['definition']> = {}): ResolvedSubagentRole {
    return {
      name: 'researcher',
      definition: { instructions: 'Research the task.', ...overrides },
    };
  }

  it('layers role instructions UNDER inherited identity by default', () => {
    const layered = layerRoleSystemPrompt(parent, undefined, role());
    expect(layered.startsWith(parent)).toBe(true);
    expect(layered).toContain('## Role: researcher');
    expect(layered).toContain('Research the task.');
  });

  it('returns inherited identity unchanged when no role is given', () => {
    expect(layerRoleSystemPrompt(parent, undefined, null)).toBe(parent);
  });

  it('an explicit per-spawn systemPrompt override always wins wholesale', () => {
    const override = 'You are a narrowly-scoped worker.';
    expect(layerRoleSystemPrompt(parent, override, role())).toBe(override);
    expect(layerRoleSystemPrompt(parent, override, null)).toBe(override);
  });

  it('a role that opts out of inheritance replaces the identity', () => {
    const layered = layerRoleSystemPrompt(parent, undefined, role({ inheritIdentity: false }));
    expect(layered).toBe('Research the task.');
    expect(layered).not.toContain(parent);
  });

  it('a blank/whitespace override does not win over the layered role', () => {
    const layered = layerRoleSystemPrompt(parent, '   ', role());
    expect(layered).toContain('## Role: researcher');
  });
});

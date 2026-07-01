import { describe, expect, it } from 'vitest';
import {
  TurnPromptVariableNamespace,
  TurnPromptVariableNamespaceError,
} from './prompt-variable-namespace.js';

describe('TurnPromptVariableNamespace', () => {
  it('assigns registered variables across phases and freezes into a merged record', () => {
    const namespace = new TurnPromptVariableNamespace();
    namespace.assignRecord('session', {
      user: 'Vega',
      char: 'Purrsephone',
      active_timezone: 'America/New_York',
    }, 'test:session-builder');
    namespace.assign('session', 'runtime_speaking_with_is_machine_intelligence', 'false', 'test:assembly');
    namespace.assignRecord('turn', {
      runtime_current_weekday: 'Friday',
      runtime_trust_level: 'trusted',
    }, 'test:turn-builder');

    const { variables, sessionVariables } = namespace.freeze();

    expect(variables).toEqual({
      user: 'Vega',
      char: 'Purrsephone',
      active_timezone: 'America/New_York',
      runtime_speaking_with_is_machine_intelligence: 'false',
      runtime_current_weekday: 'Friday',
      runtime_trust_level: 'trusted',
    });
    expect(sessionVariables).toEqual({
      user: 'Vega',
      char: 'Purrsephone',
      active_timezone: 'America/New_York',
      runtime_speaking_with_is_machine_intelligence: 'false',
    });
  });

  it('throws on a duplicate key write, naming both producers', () => {
    const namespace = new TurnPromptVariableNamespace();
    namespace.assign('session', 'active_timezone', 'America/New_York', 'test:session-builder');

    expect(() => namespace.assign('turn', 'active_timezone', 'America/New_York', 'test:turn-builder'))
      .toThrow(TurnPromptVariableNamespaceError);
    expect(() => namespace.assign('turn', 'active_timezone', 'UTC', 'test:turn-builder'))
      .toThrow(/already set by test:session-builder/);
  });

  it('treats duplicate keys as duplicates regardless of value equality', () => {
    const namespace = new TurnPromptVariableNamespace();
    namespace.assign('session', 'user', 'Vega', 'test:a');
    expect(() => namespace.assign('session', 'user', 'Vega', 'test:b'))
      .toThrow(/Duplicate prompt variable write/);
  });

  it('throws when writing after the namespace freezes', () => {
    const namespace = new TurnPromptVariableNamespace();
    namespace.assign('session', 'user', 'Vega', 'test:a');
    const { variables } = namespace.freeze();

    expect(() => namespace.assign('turn', 'runtime_trust_level', 'trusted', 'test:late'))
      .toThrow(/frozen/);
    // Frozen records reject direct property writes too (strict-mode TypeError).
    expect(() => {
      (variables as Record<string, string>).user = 'Mallory';
    }).toThrow(TypeError);
  });

  it('throws on unregistered variable keys (fail closed)', () => {
    const namespace = new TurnPromptVariableNamespace();
    expect(() => namespace.assign('turn', 'runtime_totally_unregistered_macro', 'x', 'test:rogue'))
      .toThrow(/Unregistered prompt variable "runtime_totally_unregistered_macro"/);
  });

  it('accepts open-ended character card keys through manifest prefix rules', () => {
    const namespace = new TurnPromptVariableNamespace();
    namespace.assign('session', 'character.extensions.likes', 'jazz', 'test:card');
    namespace.assign('session', 'extensions_likes', 'jazz', 'test:card');
    const { sessionVariables } = namespace.freeze();
    expect(sessionVariables['character.extensions.likes']).toBe('jazz');
  });

  it('enforces phase ordering: session writes after turn writes throw', () => {
    const namespace = new TurnPromptVariableNamespace();
    namespace.assign('turn', 'runtime_trust_level', 'trusted', 'test:turn-builder');
    expect(() => namespace.assign('session', 'user', 'Vega', 'test:late-session'))
      .toThrow(/cannot be written after a later phase/);
  });

  it('throws on double freeze', () => {
    const namespace = new TurnPromptVariableNamespace();
    namespace.freeze();
    expect(() => namespace.freeze()).toThrow(/already frozen/);
  });
});

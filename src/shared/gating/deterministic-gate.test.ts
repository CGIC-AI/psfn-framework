import { describe, expect, it } from 'vitest';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from './deterministic-gate.js';

const CHANGE_GATE: DeterministicGateDefinition = {
  lane: 'test.change',
  openWhenAny: [
    { input: 'newItems', comparator: 'gte', threshold: 3 },
    { input: 'elapsedDays', comparator: 'gte', threshold: 7 },
  ],
  closedReason: 'no_change',
};

describe('evaluateDeterministicGate', () => {
  it('opens when the first opening signal fires', () => {
    const decision = evaluateDeterministicGate(CHANGE_GATE, { newItems: 4, elapsedDays: 0 });
    expect(decision.open).toBe(true);
    expect(decision.reason).toBe('open');
    expect(decision.inputs).toEqual({ newItems: 4, elapsedDays: 0 });
  });

  it('opens when a later opening signal fires', () => {
    const decision = evaluateDeterministicGate(CHANGE_GATE, { newItems: 0, elapsedDays: 9 });
    expect(decision.open).toBe(true);
  });

  it('closes with closedReason when no opening signal fires', () => {
    const decision = evaluateDeterministicGate(CHANGE_GATE, { newItems: 2, elapsedDays: 6 });
    expect(decision.open).toBe(false);
    expect(decision.reason).toBe('no_change');
  });

  it('respects a custom openReason', () => {
    const decision = evaluateDeterministicGate(
      { ...CHANGE_GATE, openReason: 'evidence_of_change' },
      { newItems: 5, elapsedDays: 0 },
    );
    expect(decision.reason).toBe('evidence_of_change');
  });

  it('applies blockWhen pre-checks before opening signals, in order', () => {
    const gate: DeterministicGateDefinition = {
      lane: 'test.block',
      blockWhen: [{ input: 'total', comparator: 'eq', threshold: 0, reason: 'empty' }],
      openWhenAny: [{ input: 'signals', comparator: 'eq', threshold: 0 }],
      closedReason: 'low_signal',
    };
    // total 0 => blocked as empty even though the opening signal (signals eq 0) would fire.
    const blocked = evaluateDeterministicGate(gate, { total: 0, signals: 0 });
    expect(blocked.open).toBe(false);
    expect(blocked.reason).toBe('empty');
    // total present, signals eq 0 => opens.
    const open = evaluateDeterministicGate(gate, { total: 5, signals: 0 });
    expect(open.open).toBe(true);
  });

  it('supports every comparator', () => {
    const cmp = (comparator: 'gt' | 'lt' | 'gte' | 'lte' | 'eq', value: number, threshold: number): boolean =>
      evaluateDeterministicGate(
        { lane: 'c', openWhenAny: [{ input: 'v', comparator, threshold }], closedReason: 'no' },
        { v: value },
      ).open;
    expect(cmp('gt', 2, 1)).toBe(true);
    expect(cmp('gt', 1, 1)).toBe(false);
    expect(cmp('lt', 0, 1)).toBe(true);
    expect(cmp('gte', 1, 1)).toBe(true);
    expect(cmp('lte', 1, 1)).toBe(true);
    expect(cmp('eq', 1, 1)).toBe(true);
    expect(cmp('eq', 2, 1)).toBe(false);
  });

  it('fails closed when a required input is missing or non-finite', () => {
    expect(() => evaluateDeterministicGate(CHANGE_GATE, { elapsedDays: 1 })).toThrow(/finite numeric input "newItems"/);
    expect(() => evaluateDeterministicGate(CHANGE_GATE, { newItems: Number.NaN, elapsedDays: 1 }))
      .toThrow(/finite numeric input "newItems"/);
  });
});

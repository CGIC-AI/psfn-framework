import { describe, expect, it } from 'vitest';
import { GatewayConnectionBudget } from './connection-budget.js';

describe('Gateway topology connection ceiling', () => {
  it('fits two role slots per companion plus two pending sockets under a hard ceiling of 64', () => {
    expect(new GatewayConnectionBudget(false, 1).total).toBe(4);
    expect(new GatewayConnectionBudget(true, 2).total).toBe(6);
    expect(new GatewayConnectionBudget(true, 31).total).toBe(64);
    expect(() => new GatewayConnectionBudget(true, 32)).toThrow('fleet topology exceeds');
    expect(() => new GatewayConnectionBudget(true, 0)).toThrow('fleet topology exceeds');
  });
});

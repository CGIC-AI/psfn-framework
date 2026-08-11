import { describe, expect, it, vi } from 'vitest';
import {
  authenticateStockZ02,
  computeStockAuthProof,
  createStockAuthInitCommand,
  type Z02AuthIo,
} from './rcsp-auth.js';

const CAPTURED_AUTH_VECTORS = [
  ['17b73f79c71bf5bf168e1078eb66ddf6', 'cf6d3bb5d51605933fd34cecf6f302eb'],
  ['92f283e7cb9036bcd85ff84c7a831cfb', '5f5040e19c943e1ed090a0f1a5e600a8'],
  ['24c11127fce7368b4ca77aa7e378c48e', 'c0e9e738dc98d377ccf0b38e4bca77aa'],
  ['4351a0bbc3bb17e4c30be9463fbb5ed3', '410a08db30e1868e836efbae3f583b9c'],
  ['a3104656e03e05f4129860f4b4dbea28', 'ec8d8325e24d91c6a4978de87c8fd920'],
] as const;

describe('stock Z02 RCSP authentication', () => {
  it.each(CAPTURED_AUTH_VECTORS)('matches the recovered E1 cipher for %s', (challenge, proof) => {
    expect(toHex(computeStockAuthProof(fromHex(challenge)))).toBe(proof);
  });

  it('constructs the exact stock auth-init command', () => {
    expect(toHex(createStockAuthInitCommand()))
      .toBe('fedcbac00600020001ef');
  });

  it('completes mutual authentication only after both proofs pass', async () => {
    const hostChallenge = fromHex('92f283e7cb9036bcd85ff84c7a831cfb');
    const badgeChallenge = fromHex('24c11127fce7368b4ca77aa7e378c48e');
    const notifications: Uint8Array[] = [];
    const writes: Uint8Array[] = [];
    const io: Z02AuthIo = {
      write: vi.fn(async (value: Uint8Array) => {
        writes.push(value.slice());
        if (value[0] === 0x00 && value.length === 17) {
          notifications.push(concat(0x01, computeStockAuthProof(value.slice(1))));
        } else if (toHex(value) === '0270617373') {
          notifications.push(concat(0x00, badgeChallenge));
        } else if (value[0] === 0x01 && value.length === 17) {
          notifications.push(fromHex('0270617373'));
        }
      }),
      nextNotification: vi.fn(async () => {
        const value = notifications.shift();
        if (!value) throw new Error('test notification queue is empty');
        return value;
      }),
    };

    await authenticateStockZ02(io, { randomBytes: () => hostChallenge });

    expect(writes.map(toHex)).toEqual([
      'fedcbac00600020001ef',
      `00${toHex(hostChallenge)}`,
      '0270617373',
      `01${toHex(computeStockAuthProof(badgeChallenge))}`,
    ]);
  });

  it('fails closed when the badge cannot prove the stock link key', async () => {
    const writes: Uint8Array[] = [];
    const io: Z02AuthIo = {
      write: vi.fn(async (value: Uint8Array) => { writes.push(value.slice()); }),
      nextNotification: vi.fn(async () => concat(0x01, new Uint8Array(16))),
    };

    await expect(authenticateStockZ02(io, {
      randomBytes: () => fromHex('92f283e7cb9036bcd85ff84c7a831cfb'),
    })).rejects.toThrow('Z02 authentication failed');
    expect(writes.map(toHex)).not.toContain('0270617373');
  });
});

function concat(prefix: number, value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value.length + 1);
  result[0] = prefix;
  result.set(value, 1);
  return result;
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

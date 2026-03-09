import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { TurnID } from './types.js';

const TURN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTurnId(): TurnID {
  return uuidv7() as TurnID;
}

export function isTurnId(value: string): value is TurnID {
  return TURN_ID_PATTERN.test(value);
}

export function parseTurnId(value: unknown, fieldName = 'turnId'): TurnID | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (!isTurnId(normalized)) {
    throw new Error(`Invalid ${fieldName}: expected UUIDv7, received \"${value}\"`);
  }
  return normalized as TurnID;
}

export function backfillLegacyTurnId(seed: string): TurnID {
  const digest = createHash('sha256').update(seed).digest('hex');
  const part1 = digest.slice(0, 8);
  const part2 = digest.slice(8, 12);
  const part3 = `7${digest.slice(12, 15)}`;
  const part4 = `a${digest.slice(15, 18)}`;
  const part5 = digest.slice(18, 30);
  return `${part1}-${part2}-${part3}-${part4}-${part5}` as TurnID;
}

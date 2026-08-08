import { describe, expect, it } from 'vitest';
import {
  clamp,
  clampSigned,
  clampUnit,
  clampWithMidpointNaN,
  positiveIntegerOr,
  requirePositiveInteger,
  toFlooredPositiveInteger,
  toPositiveInteger,
} from './numeric.js';

describe('clamp', () => {
  it('clamps finite numbers between min and max', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('falls back to 0 for non-numeric values', () => {
    expect(clamp('hello' as unknown as number, 0, 10)).toBe(0);
    expect(clamp(NaN, 0, 10)).toBe(0);
    expect(clamp(undefined as unknown as number, 0, 10)).toBe(0);
  });
});

describe('clampUnit', () => {
  it('clamps to [0, 1]', () => {
    expect(clampUnit(0.5)).toBe(0.5);
    expect(clampUnit(2)).toBe(1);
    expect(clampUnit(-1)).toBe(0);
  });

  it('returns fallback for non-numeric values when provided', () => {
    expect(clampUnit('x' as unknown as number, 0.5)).toBe(0.5);
    expect(clampUnit(undefined as unknown as number, undefined)).toBeUndefined();
  });
});

describe('clampSigned', () => {
  it('clamps to [-1, 1]', () => {
    expect(clampSigned(0.5)).toBe(0.5);
    expect(clampSigned(5)).toBe(1);
    expect(clampSigned(-5)).toBe(-1);
  });
});

describe('clampWithMidpointNaN', () => {
  it('clamps finite numbers between min and max', () => {
    expect(clampWithMidpointNaN(5, 0, 10)).toBe(5);
    expect(clampWithMidpointNaN(-5, 0, 10)).toBe(0);
    expect(clampWithMidpointNaN(15, 0, 10)).toBe(10);
  });

  it('maps NaN to the midpoint of the range', () => {
    expect(clampWithMidpointNaN(Number.NaN, 0, 1)).toBe(0.5);
    expect(clampWithMidpointNaN(Number.NaN, -1, 1)).toBe(0);
    expect(clampWithMidpointNaN(Number.NaN, 10, 20)).toBe(15);
  });

  it('clamps finite bounds for non-NaN infinities', () => {
    expect(clampWithMidpointNaN(Number.POSITIVE_INFINITY, 0, 1)).toBe(1);
    expect(clampWithMidpointNaN(Number.NEGATIVE_INFINITY, 0, 1)).toBe(0);
  });
});

describe('toPositiveInteger', () => {
  it('accepts positive integers', () => {
    expect(toPositiveInteger(1)).toBe(1);
    expect(toPositiveInteger(42)).toBe(42);
  });

  it('accepts string representations of positive integers', () => {
    expect(toPositiveInteger('  7  ')).toBe(7);
    expect(toPositiveInteger('+12')).toBe(12);
  });

  it('rejects non-positive and non-integer values', () => {
    expect(toPositiveInteger(0)).toBeUndefined();
    expect(toPositiveInteger(-1)).toBeUndefined();
    expect(toPositiveInteger(1.5)).toBeUndefined();
    expect(toPositiveInteger('1.5')).toBeUndefined();
    expect(toPositiveInteger('0x10')).toBeUndefined();
    expect(toPositiveInteger('')).toBeUndefined();
    expect(toPositiveInteger('abc')).toBeUndefined();
    expect(toPositiveInteger(null)).toBeUndefined();
    expect(toPositiveInteger(undefined)).toBeUndefined();
  });
});

describe('toFlooredPositiveInteger', () => {
  it('accepts finite positive numbers and floors them', () => {
    expect(toFlooredPositiveInteger(1)).toBe(1);
    expect(toFlooredPositiveInteger(42)).toBe(42);
    expect(toFlooredPositiveInteger(1.9)).toBe(1);
    expect(toFlooredPositiveInteger(2.1)).toBe(2);
  });

  it('rejects non-positive and non-finite values', () => {
    expect(toFlooredPositiveInteger(0)).toBeUndefined();
    expect(toFlooredPositiveInteger(-1)).toBeUndefined();
    expect(toFlooredPositiveInteger(NaN)).toBeUndefined();
    expect(toFlooredPositiveInteger(Infinity)).toBeUndefined();
    expect(toFlooredPositiveInteger(-Infinity)).toBeUndefined();
  });

  it('does not parse strings', () => {
    expect(toFlooredPositiveInteger('7')).toBeUndefined();
    expect(toFlooredPositiveInteger('')).toBeUndefined();
  });
});

describe('positiveIntegerOr', () => {
  it('returns parsed value or fallback', () => {
    expect(positiveIntegerOr(3, 10)).toBe(3);
    expect(positiveIntegerOr('3', 10)).toBe(3);
    expect(positiveIntegerOr(undefined, 10)).toBe(10);
    expect(positiveIntegerOr(0, 10)).toBe(10);
    expect(positiveIntegerOr('abc', 10)).toBe(10);
  });
});

describe('requirePositiveInteger', () => {
  it('returns valid positive integers', () => {
    expect(requirePositiveInteger(5, 'limit')).toBe(5);
    expect(requirePositiveInteger('5', 'limit')).toBe(5);
  });

  it('throws for invalid values', () => {
    expect(() => requirePositiveInteger(0, 'limit')).toThrow('limit must be a positive integer, received 0');
    expect(() => requirePositiveInteger(-1, 'limit')).toThrow('limit must be a positive integer, received -1');
    expect(() => requirePositiveInteger(1.5, 'limit')).toThrow('limit must be a positive integer, received 1.5');
    expect(() => requirePositiveInteger('abc', 'limit')).toThrow('limit must be a positive integer, received abc');
  });
});

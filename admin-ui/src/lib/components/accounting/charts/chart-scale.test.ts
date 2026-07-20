import { describe, expect, it } from 'vitest';
import {
  buildLinearTicks,
  mergeTopNSeries,
  niceMax,
  stackSegments,
} from './chart-scale';

describe('chart scale helpers', () => {
  describe('niceMax', () => {
    it('guards zero, negative, and non-finite inputs', () => {
      expect(niceMax(0)).toBe(0);
      expect(niceMax(-12)).toBe(0);
      expect(niceMax(Number.NaN)).toBe(0);
      expect(niceMax(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('rounds sub-one values up to a 1/2/2.5/5 step', () => {
      expect(niceMax(0.03)).toBe(0.05);
      expect(niceMax(0.2)).toBe(0.2);
      expect(niceMax(0.21)).toBe(0.25);
      expect(niceMax(0.51)).toBe(1);
    });

    it('keeps exact steps and rolls larger values to the next exponent', () => {
      expect(niceMax(2.5)).toBe(2.5);
      expect(niceMax(23)).toBe(25);
      expect(niceMax(51)).toBe(100);
    });
  });

  describe('buildLinearTicks', () => {
    it('builds the requested number of ticks including zero and the maximum', () => {
      expect(buildLinearTicks(10, 5)).toEqual([0, 2.5, 5, 7.5, 10]);
      expect(buildLinearTicks(0.25, 3)).toEqual([0, 0.125, 0.25]);
    });

    it('returns a safe baseline for invalid maxima and at least two ticks otherwise', () => {
      expect(buildLinearTicks(0, 5)).toEqual([0]);
      expect(buildLinearTicks(-4, 5)).toEqual([0]);
      expect(buildLinearTicks(Number.NaN, 5)).toEqual([0]);
      expect(buildLinearTicks(10, 1)).toEqual([0, 10]);
    });
  });

  describe('stackSegments', () => {
    it('fills missing series keys and returns raw and normalized stack boundaries', () => {
      expect(stackSegments([
        {
          startMs: 100,
          segments: [
            { key: 'alpha', value: 2 },
            { key: 'gamma', value: 6 },
          ],
        },
      ], ['alpha', 'beta', 'gamma'])).toEqual([
        {
          startMs: 100,
          total: 8,
          segments: [
            { key: 'alpha', value: 2, start: 0, end: 2, startRatio: 0, endRatio: 0.25 },
            { key: 'beta', value: 0, start: 2, end: 2, startRatio: 0.25, endRatio: 0.25 },
            { key: 'gamma', value: 6, start: 2, end: 8, startRatio: 0.25, endRatio: 1 },
          ],
        },
      ]);
    });

    it('keeps all-zero buckets finite and pinned to the baseline', () => {
      expect(stackSegments([
        {
          startMs: 200,
          segments: [
            { key: 'alpha', value: 0 },
            { key: 'beta', value: Number.NaN },
          ],
        },
      ], ['alpha', 'beta'])).toEqual([
        {
          startMs: 200,
          total: 0,
          segments: [
            { key: 'alpha', value: 0, start: 0, end: 0, startRatio: 0, endRatio: 0 },
            { key: 'beta', value: 0, start: 0, end: 0, startRatio: 0, endRatio: 0 },
          ],
        },
      ]);
    });

    it('sums duplicate keys and clamps negative values before stacking', () => {
      const [bucket] = stackSegments([
        {
          startMs: 300,
          segments: [
            { key: 'alpha', value: 2 },
            { key: 'alpha', value: 3 },
            { key: 'beta', value: -9 },
          ],
        },
      ], ['alpha', 'beta']);

      expect(bucket?.total).toBe(5);
      expect(bucket?.segments.map(({ key, value }) => ({ key, value }))).toEqual([
        { key: 'alpha', value: 5 },
        { key: 'beta', value: 0 },
      ]);
    });
  });

  describe('mergeTopNSeries', () => {
    it('includes ties at the N boundary and merges every remaining key into Other', () => {
      const buckets = [
        {
          startMs: 100,
          segments: [
            { key: 'alpha', value: 6 },
            { key: 'beta', value: 4 },
            { key: 'gamma', value: 3 },
            { key: 'delta', value: 1 },
          ],
        },
        {
          startMs: 200,
          segments: [
            { key: 'alpha', value: 4 },
            { key: 'beta', value: 4 },
            { key: 'gamma', value: 5 },
            { key: 'delta', value: 1 },
            { key: 'not-in-totals', value: 2 },
          ],
        },
      ];

      expect(mergeTopNSeries(buckets, [
        { key: 'alpha', value: 10 },
        { key: 'beta', value: 8 },
        { key: 'gamma', value: 8 },
        { key: 'delta', value: 2 },
      ], 2)).toEqual([
        {
          startMs: 100,
          segments: [
            { key: 'alpha', value: 6 },
            { key: 'beta', value: 4 },
            { key: 'gamma', value: 3 },
            { key: 'Other', value: 1 },
          ],
        },
        {
          startMs: 200,
          segments: [
            { key: 'alpha', value: 4 },
            { key: 'beta', value: 4 },
            { key: 'gamma', value: 5 },
            { key: 'Other', value: 3 },
          ],
        },
      ]);
    });

    it('merges every series when N is zero without producing NaN for all-zero buckets', () => {
      expect(mergeTopNSeries([
        {
          startMs: 100,
          segments: [
            { key: 'alpha', value: 0 },
            { key: 'beta', value: 0 },
          ],
        },
      ], [
        { key: 'alpha', value: 0 },
        { key: 'beta', value: 0 },
      ], 0)).toEqual([
        {
          startMs: 100,
          segments: [{ key: 'Other', value: 0 }],
        },
      ]);
    });

    it('omits Other when every declared series is retained', () => {
      expect(mergeTopNSeries([
        { startMs: 100, segments: [{ key: 'alpha', value: 2 }] },
      ], [{ key: 'alpha', value: 2 }], 5)).toEqual([
        { startMs: 100, segments: [{ key: 'alpha', value: 2 }] },
      ]);
    });
  });
});

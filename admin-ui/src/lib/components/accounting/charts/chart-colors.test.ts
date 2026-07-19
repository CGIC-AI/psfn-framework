import { describe, expect, it } from 'vitest';
import { SERIES_COLORS, seriesColor } from './chart-colors';

describe('chart series colors', () => {
  it('exposes at least eight theme-token colors without raw hex values', () => {
    expect(SERIES_COLORS.length).toBeGreaterThanOrEqual(8);
    expect(SERIES_COLORS.every(color => color.startsWith('var(--color-'))).toBe(true);
    expect(SERIES_COLORS.some(color => color.includes('#'))).toBe(false);
  });

  it('cycles deterministically in both directions', () => {
    expect(seriesColor(0)).toBe(SERIES_COLORS[0]);
    expect(seriesColor(SERIES_COLORS.length)).toBe(SERIES_COLORS[0]);
    expect(seriesColor(-1)).toBe(SERIES_COLORS.at(-1));
    expect(seriesColor(Number.NaN)).toBe(SERIES_COLORS[0]);
  });
});

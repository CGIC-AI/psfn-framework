/**
 * Garden theme packs override these same CSS variables for light and dark
 * surfaces. Mid/deep tones remain distinguishable against each pack's card
 * background without freezing charts to the default theme's raw colors.
 */
export const SERIES_COLORS = [
  'var(--color-gold-600)',
  'var(--color-moss-600)',
  'var(--color-petal-600)',
  'var(--color-wilt-600)',
  'var(--color-bark-700)',
  'var(--color-shadow-500)',
  'var(--color-gold-800)',
  'var(--color-moss-800)',
  'var(--color-petal-800)',
  'var(--color-wilt-800)',
] as const;

export function seriesColor(index: number): string {
  const integerIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  const normalizedIndex = ((integerIndex % SERIES_COLORS.length) + SERIES_COLORS.length)
    % SERIES_COLORS.length;
  return SERIES_COLORS[normalizedIndex] ?? SERIES_COLORS[0];
}

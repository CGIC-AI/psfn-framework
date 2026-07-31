import { describe, expect, it } from 'vitest';
import { formatDimensionValue } from './format.js';

describe('formatDimensionValue', () => {
  it('renders historical retired charge attribution explicitly', () => {
    expect(formatDimensionValue('chargeSurface', 'retired')).toBe('Retired / legacy');
  });

  it('keeps ordinary and non-charge retired dimension values unchanged', () => {
    expect(formatDimensionValue('chargeSurface', 'externalModelConsult'))
      .toBe('externalModelConsult');
    expect(formatDimensionValue('purpose', 'retired')).toBe('retired');
  });
});

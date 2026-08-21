import { describe, expect, it } from 'vitest';
import { resolveDiscoveredModelWindow } from './discovered-model-window';

describe('discovered model horizontal window', () => {
  it('keeps only the visible two-row columns plus one overscan column mounted', () => {
    expect(resolveDiscoveredModelWindow({
      itemCount: 100,
      scrollLeft: 3_640,
      viewportWidth: 704,
      columnPitch: 364,
      itemsPerColumn: 2,
      overscanColumns: 1,
      bootstrapColumns: 3,
    })).toEqual({
      columnCount: 50,
      startColumn: 9,
      endColumn: 13,
      startItem: 18,
      endItem: 26,
      offsetPx: 3_276,
      totalWidthPx: 18_200,
    });
  });

  it('returns a bounded server/bootstrap window before viewport geometry is available', () => {
    expect(resolveDiscoveredModelWindow({
      itemCount: 100,
      scrollLeft: 0,
      viewportWidth: 0,
      columnPitch: 0,
      itemsPerColumn: 2,
      overscanColumns: 1,
      bootstrapColumns: 3,
    })).toEqual({
      columnCount: 50,
      startColumn: 0,
      endColumn: 3,
      startItem: 0,
      endItem: 6,
      offsetPx: 0,
      totalWidthPx: null,
    });
  });
});

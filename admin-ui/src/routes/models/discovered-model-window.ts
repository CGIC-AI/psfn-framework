export interface DiscoveredModelWindowInput {
  itemCount: number;
  scrollLeft: number;
  viewportWidth: number;
  columnPitch: number;
  itemsPerColumn: number;
  overscanColumns: number;
  bootstrapColumns: number;
}

export interface DiscoveredModelWindow {
  columnCount: number;
  startColumn: number;
  endColumn: number;
  startItem: number;
  endItem: number;
  offsetPx: number;
  totalWidthPx: number | null;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveInteger(value: number): number {
  return Math.max(1, nonNegativeInteger(value));
}

export function resolveDiscoveredModelWindow(
  input: DiscoveredModelWindowInput,
): DiscoveredModelWindow {
  const itemCount = nonNegativeInteger(input.itemCount);
  const itemsPerColumn = positiveInteger(input.itemsPerColumn);
  const columnCount = Math.ceil(itemCount / itemsPerColumn);
  const bootstrapColumns = positiveInteger(input.bootstrapColumns);
  const columnPitch = Number.isFinite(input.columnPitch) && input.columnPitch > 0
    ? input.columnPitch
    : 0;
  const viewportWidth = Number.isFinite(input.viewportWidth) && input.viewportWidth > 0
    ? input.viewportWidth
    : 0;

  if (columnPitch === 0 || viewportWidth === 0) {
    const endColumn = Math.min(columnCount, bootstrapColumns);
    return {
      columnCount,
      startColumn: 0,
      endColumn,
      startItem: 0,
      endItem: Math.min(itemCount, endColumn * itemsPerColumn),
      offsetPx: 0,
      totalWidthPx: null,
    };
  }

  const overscanColumns = nonNegativeInteger(input.overscanColumns);
  const scrollLeft = Number.isFinite(input.scrollLeft) && input.scrollLeft > 0
    ? input.scrollLeft
    : 0;
  const firstVisibleColumn = Math.floor(scrollLeft / columnPitch);
  const visibleColumnCount = Math.ceil(viewportWidth / columnPitch);
  const startColumn = Math.max(0, firstVisibleColumn - overscanColumns);
  const endColumn = Math.min(
    columnCount,
    firstVisibleColumn + visibleColumnCount + overscanColumns,
  );

  return {
    columnCount,
    startColumn,
    endColumn,
    startItem: startColumn * itemsPerColumn,
    endItem: Math.min(itemCount, endColumn * itemsPerColumn),
    offsetPx: startColumn * columnPitch,
    totalWidthPx: columnCount * columnPitch,
  };
}

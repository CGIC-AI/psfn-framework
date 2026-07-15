import {
  MODEL_USAGE_GROUP_DIMENSIONS,
  type ModelUsageExportData,
  type ModelUsageExportRow,
  type ModelUsageGroupDimension,
} from '../../../shared/telemetry/model-usage.js';

export type ModelUsageExportFormat = 'csv' | 'json';

export interface SerializedModelUsageExport {
  body: string;
  contentType: string;
  filename: string;
  rowCount: number;
}

const CSV_BASE_COLUMNS = ['id', 'logicalCallId', 'attempt', 'recordedAtMs'] as const;
const CSV_METRIC_COLUMNS = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'totalTokens',
  'providerInputCostUsd',
  'providerCacheReadCostUsd',
  'providerCacheWriteCostUsd',
  'providerOutputCostUsd',
  'providerCostUsd',
  'estimatedInputCostUsd',
  'estimatedCacheReadCostUsd',
  'estimatedCacheWriteCostUsd',
  'estimatedOutputCostUsd',
  'estimatedCostUsd',
  'effectiveInputCostUsd',
  'effectiveCacheReadCostUsd',
  'effectiveCacheWriteCostUsd',
  'effectiveOutputCostUsd',
  'effectiveCostUsd',
  'durationMs',
  'ttftMs',
] as const;

function dimensionValue(row: ModelUsageExportRow, dimension: ModelUsageGroupDimension): string {
  switch (dimension) {
    case 'provider': return row.provider;
    case 'model': return row.model;
    case 'slotKey': return row.slotKey ?? 'unknown';
    case 'requestedProvider': return row.requestedProvider ?? 'unknown';
    case 'requestedModel': return row.requestedModel ?? 'unknown';
    case 'callKind': return row.callKind;
    case 'status': return row.status;
    case 'costSource': return row.costSource;
    default: {
      const value: unknown = row.attribution[dimension];
      return typeof value === 'string' ? value : 'unknown';
    }
  }
}

function metricValues(row: ModelUsageExportRow): Array<number | string> {
  return [
    row.inputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    row.outputTokens,
    row.totalTokens,
    row.providerCost.input ?? '',
    row.providerCost.cacheRead ?? '',
    row.providerCost.cacheWrite ?? '',
    row.providerCost.output ?? '',
    row.providerCost.total ?? '',
    row.estimatedCost.input ?? '',
    row.estimatedCost.cacheRead ?? '',
    row.estimatedCost.cacheWrite ?? '',
    row.estimatedCost.output ?? '',
    row.estimatedCost.total ?? '',
    row.effectiveCost.input ?? '',
    row.effectiveCost.cacheRead ?? '',
    row.effectiveCost.cacheWrite ?? '',
    row.effectiveCost.output ?? '',
    row.effectiveCost.total ?? '',
    row.durationMs ?? '',
    row.ttftMs ?? '',
  ];
}

function csvCell(value: number | string): string {
  if (typeof value === 'number') return String(value);
  const formulaSafe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

function serializeCsv(data: ModelUsageExportData): string {
  const headers = [
    ...CSV_BASE_COLUMNS,
    ...MODEL_USAGE_GROUP_DIMENSIONS,
    ...CSV_METRIC_COLUMNS,
  ];
  const rows = data.rows.map(row => [
    row.id,
    row.logicalCallId,
    row.attempt,
    row.recordedAtMs,
    ...MODEL_USAGE_GROUP_DIMENSIONS.map(dimension => dimensionValue(row, dimension)),
    ...metricValues(row),
  ].map(csvCell).join(','));
  return `${[headers.map(csvCell).join(','), ...rows].join('\r\n')}\r\n`;
}

export function serializeModelUsageExport(
  data: ModelUsageExportData,
  format: ModelUsageExportFormat,
): SerializedModelUsageExport {
  const suffix = `${data.resolvedRange.sinceMs}-${data.resolvedRange.untilMs}`;
  if (format === 'json') {
    return {
      body: JSON.stringify(data),
      contentType: 'application/json; charset=utf-8',
      filename: `model-usage-${suffix}.json`,
      rowCount: data.rows.length,
    };
  }
  return {
    body: serializeCsv(data),
    contentType: 'text/csv; charset=utf-8',
    filename: `model-usage-${suffix}.csv`,
    rowCount: data.rows.length,
  };
}

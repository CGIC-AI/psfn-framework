import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readSource = async (relativePath: string): Promise<string> => (
  readFile(new URL(relativePath, import.meta.url), 'utf8')
);

describe('PostgresModelUsageStore phased module boundary', () => {
  it('delegates capture and query ownership behind the public class', async () => {
    const [facade, store, capture, common, queries, queryInput, querySupport, rows] = await Promise.all([
      readSource('./model-usage-store.ts'),
      readSource('./model-usage-store/store.ts'),
      readSource('./model-usage-store/capture.ts'),
      readSource('./model-usage-store/common.ts'),
      readSource('./model-usage-store/queries.ts'),
      readSource('./model-usage-store/query-input.ts'),
      readSource('./model-usage-store/query-support.ts'),
      readSource('./model-usage-store/rows.ts'),
    ]);

    expect(facade).toContain("from './model-usage-store/store.js'");
    expect(facade).not.toContain('class PostgresModelUsageStore');
    expect(store).toContain('export class PostgresModelUsageStore');
    expect(store).toContain("from './capture.js'");
    expect(store).toContain("from './common.js'");
    expect(store).toContain("from './queries.js'");
    expect(capture).not.toContain("from '../model-usage-store.js'");
    expect(capture).toContain('export class PostgresModelUsageCapture');
    expect(capture).toContain('INSERT INTO model_usage_events');
    expect(capture).toContain('UPDATE icp_conversation_cost_reservations');
    expect(store).toContain('private readonly capture: PostgresModelUsageCapture');
    expect(store).toContain('private readonly queries: PostgresModelUsageQueries');
    expect(store).not.toContain('INSERT INTO model_usage_events');
    expect(store).not.toContain('UPDATE icp_conversation_cost_reservations');
    expect(store).not.toContain('SELECT *\n      FROM model_usage_events');
    expect(queries).toContain("from './query-input.js'");
    expect(queries).toContain("from './query-support.js'");
    expect(queries).toContain("from './rows.js'");
    expect(queries).toContain('SELECT *\n      FROM model_usage_events');
    expect(queries).toContain('getFleetModelUsageSummary');
    expect(queries).toContain('getModelBudgetSpend');
    expect(queries).toContain('exportUsageEvents');
    expect(queries).not.toContain("from '../model-usage-store.js'");
    expect(common).not.toContain("from '../model-usage-store.js'");
    expect(queryInput).not.toContain("from '../model-usage-store.js'");
    expect(querySupport).not.toContain("from '../model-usage-store.js'");
    expect(querySupport).not.toContain("from './capture.js'");
    expect(rows).not.toContain("from '../model-usage-store.js'");
  });

  it('does not invent retention behavior absent from the store contract', async () => {
    const sources = await Promise.all([
      readSource('./model-usage-store.ts'),
      readSource('./model-usage-store/store.ts'),
      readSource('./model-usage-store/capture.ts'),
      readSource('./model-usage-store/queries.ts'),
    ]);

    expect(sources.join('\n')).not.toMatch(/DELETE FROM model_usage_events/u);
    expect(sources.join('\n')).not.toMatch(/\b(?:prune|retention)\w*\s*\(/u);
  });

  it('keeps the real agent runtime on the stable public import path', async () => {
    const runtime = await readSource('../../app/agent/core-runtime.ts');

    expect(runtime).toContain("from '../../persistence/postgres/model-usage-store.js'");
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readSource = async (relativePath: string): Promise<string> => (
  readFile(new URL(relativePath, import.meta.url), 'utf8')
);

describe('PostgresModelUsageStore phased module boundary', () => {
  it('extracts phased support modules without moving the public class', async () => {
    const [store, capture, common, querySupport, rows] = await Promise.all([
      readSource('./model-usage-store.ts'),
      readSource('./model-usage-store/capture.ts'),
      readSource('./model-usage-store/common.ts'),
      readSource('./model-usage-store/query-support.ts'),
      readSource('./model-usage-store/rows.ts'),
    ]);

    expect(store).toContain('export class PostgresModelUsageStore');
    expect(store).toContain("from './model-usage-store/capture.js'");
    expect(store).toContain("from './model-usage-store/common.js'");
    expect(store).toContain("from './model-usage-store/query-support.js'");
    expect(store).toContain("from './model-usage-store/rows.js'");
    expect(capture).not.toContain("from '../model-usage-store.js'");
    expect(common).not.toContain("from '../model-usage-store.js'");
    expect(querySupport).not.toContain("from '../model-usage-store.js'");
    expect(querySupport).not.toContain("from './capture.js'");
    expect(rows).not.toContain("from '../model-usage-store.js'");
  });

  it('keeps the real agent runtime on the stable public import path', async () => {
    const runtime = await readSource('../../app/agent/core-runtime.ts');

    expect(runtime).toContain("from '../../persistence/postgres/model-usage-store.js'");
  });
});

import { describe, expect, it } from 'vitest';
import {
  findTransitiveDependents,
  matchRegisteredSeams,
  type ImportGraph,
} from './import-graph.js';

describe('import graph impact analysis', () => {
  it('computes sorted transitive dependents without including the changed seam', () => {
    const graph: ImportGraph = new Map([
      ['/src/app/main.ts', ['/src/startup/composition.ts']],
      ['/src/core/consumer.ts', ['/src/seams/gateway.ts']],
      ['/src/feature/leaf.ts', []],
      ['/src/seams/gateway.ts', []],
      ['/src/startup/composition.ts', ['/src/core/consumer.ts']],
      ['/src/unrelated.ts', ['/src/feature/leaf.ts']],
    ]);

    expect(findTransitiveDependents(graph, '/src/seams/gateway.ts')).toEqual([
      '/src/app/main.ts',
      '/src/core/consumer.ts',
      '/src/startup/composition.ts',
    ]);
  });

  it('matches only explicit registered seams and normalizes path separators', () => {
    const registeredSeams = [
      'src/boundary/gateway/server.ts',
      'src/core/session/manager.ts',
      'src/faculties/memory/writer.ts',
    ];

    expect(matchRegisteredSeams([
      './src/core/session/manager.ts',
      'src\\boundary\\gateway\\server.ts',
      'src/unrelated.ts',
    ], registeredSeams)).toEqual([
      'src/boundary/gateway/server.ts',
      'src/core/session/manager.ts',
    ]);
    expect(matchRegisteredSeams(['src/unrelated.ts'], registeredSeams)).toEqual([]);
  });
});

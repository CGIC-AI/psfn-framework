import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_WORK_AUTOMATA_CLASSES, BACKGROUND_WORK_KINDS } from '../../core/agent/background-work/types.js';
import { PRODUCTION_AUTOMATA_CLASSES } from './registry-contract.js';
import { PRODUCTION_AUTOMATA_SPAWN_PATHS } from './production-registration.js';

describe('production automata registration', () => {
  it('covers every class and every durable background-work kind', () => {
    const classIds = PRODUCTION_AUTOMATA_CLASSES.map(entry => entry.id).sort();
    expect([...new Set(PRODUCTION_AUTOMATA_SPAWN_PATHS.map(entry => entry.classId))].sort())
      .toEqual(classIds);
    expect(Object.keys(BACKGROUND_WORK_AUTOMATA_CLASSES).sort())
      .toEqual([...BACKGROUND_WORK_KINDS].sort());
  });

  it('rejects unregistered production Worker constructors and detached Faculty launches', () => {
    const productionFiles = globSync('src/**/*.ts').filter(path => (
      !path.endsWith('.test.ts')
      && !path.endsWith('.integration.test.ts')
      && !path.includes('/test-support/')
    ));
    const workerLaunches = productionFiles.flatMap((sourcePath) => {
      const source = readFileSync(sourcePath, 'utf8');
      return [...source.matchAll(/new\s+([A-Z][A-Za-z0-9]*Worker)\s*\(/gu)]
        .map(match => ({ sourcePath, workerSymbol: match[1] }));
    });
    expect(workerLaunches.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)))
      .toEqual(PRODUCTION_AUTOMATA_SPAWN_PATHS
      .filter(entry => entry.workerSymbol !== undefined)
      .map(entry => ({ sourcePath: entry.sourcePath, workerSymbol: entry.workerSymbol }))
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)));

    const detachedFacultyLaunches = productionFiles
      .filter(sourcePath => sourcePath.startsWith('src/faculties/'))
      .filter(sourcePath => readFileSync(sourcePath, 'utf8').includes('queueMicrotask('));
    expect(detachedFacultyLaunches.sort()).toEqual(PRODUCTION_AUTOMATA_SPAWN_PATHS
      .filter(entry => entry.launchMarker === 'queueMicrotask')
      .map(entry => entry.sourcePath)
      .sort());
  });
});

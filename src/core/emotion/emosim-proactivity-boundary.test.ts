import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(testDir, '../..');

function collectTypeScriptFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) collectTypeScriptFiles(fullPath, files);
    else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) files.push(fullPath);
  }
  return files;
}

describe('EmoSim proactivity authority boundary', () => {
  it('observer-eval modules cannot publish or consume production impulses', () => {
    const evalRoot = path.join(srcRoot, 'core/eval/observer-sidecar');
    const violations = collectTypeScriptFiles(evalRoot)
      .filter(file => !file.endsWith('.test.ts'))
      .filter(file => readFileSync(file, 'utf8').includes(
        'emotion.emosim.proactivity.impulse',
      ));
    expect(violations.map(file => path.relative(srcRoot, file))).toEqual([]);
  });

  it('memory, prompts, contacts, concerns, and personality cannot read eval modules', () => {
    const roots = [
      'faculties/memory',
      'core/contacts',
      'core/intention',
      'core/identity',
    ];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of collectTypeScriptFiles(path.join(srcRoot, root))) {
        const source = readFileSync(file, 'utf8');
        if (/from\s+['"][^'"]*core\/eval|from\s+['"][^'"]*eval\/observer-sidecar/.test(source)) {
          violations.push(path.relative(srcRoot, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

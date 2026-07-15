import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// mmo9.7.1 acceptance: every autonomous LLM `.complete(...)` call under src/core
// and src/faculties must route through the typed entry `completeWithWorkSpec`
// (which requires an LLMWorkSpec), never a raw provider `.complete(...)` that
// could omit the spec. This scan is the AST/lint backstop to the type-level
// requirement on the entry.

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(THIS_DIR, '..', '..');
const SCAN_ROOTS = [join(SRC_ROOT, 'core'), join(SRC_ROOT, 'faculties')];

// Files that legitimately reference `.complete(` without being an autonomous
// leaf call site:
//  - contracts.ts defines the LLMProviderPort adapter (forwarding definition).
const ALLOWLIST = new Set<string>([
  'core/agent/contracts.ts',
]);

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts')) continue;
      if (name.endsWith('.test.ts')) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

// Strip line and block comments so commented examples do not trip the scan.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// A `.complete(` invocation whose receiver looks like an LLM provider/client.
const PROVIDER_COMPLETE_CALL = /\b(?:this\.)?(?:llm[A-Za-z]*|provider|client|gateway|completionProvider)\.complete\s*\(/i;

describe('autonomous LLMWorkSpec enforcement (src/core + src/faculties)', () => {
  const files = SCAN_ROOTS.flatMap(listTsFiles);

  it('finds source to scan', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no raw provider `.complete(` autonomous call bypassing completeWithWorkSpec', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split('\\').join('/');
      if (ALLOWLIST.has(rel)) continue;
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      lines.forEach((line, index) => {
        if (PROVIDER_COMPLETE_CALL.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `raw provider .complete( calls must use completeWithWorkSpec:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('every adopted call site references completeWithWorkSpec', () => {
    // Spot-check representative adopted files import/use the typed entry.
    const adopted = [
      'core/emotion/appraisal.ts',
      'core/intention/concern-candidates.ts',
      'core/icp/initiation-consent-evaluator.ts',
      'core/session/manager/compaction-service.ts',
      'core/tools/focus.ts',
      'core/tools/analysis-workbench/loop.ts',
      'faculties/memory/extraction/orchestrator.ts',
      'faculties/memory/sleeptime-agent.ts',
      'faculties/introspection/model-runtime.ts',
      'faculties/context-feedback/evaluator.ts',
    ];
    for (const rel of adopted) {
      const source = readFileSync(join(SRC_ROOT, rel), 'utf8');
      expect(source, `${rel} should use completeWithWorkSpec`).toContain('completeWithWorkSpec(');
    }
  });
});

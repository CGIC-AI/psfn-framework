import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// psfn-framework-fxt1 backstop: `preemptionProtected` makes an autonomous model
// call non-preemptable at the gateway gate — the welfare/anti-starvation
// privilege. Its authority lives solely in the background-work store
// (`welfare_claimed`, set by the supervisor path), and the gateway re-verifies a
// paired `welfareGrantJobId` before honoring the flag. This scan is the AST/lint
// backstop (mirrors autonomous-workspec-enforcement) that keeps the SANCTIONED
// path the only setter of `preemptionProtected` / `welfareGrantJobId` in
// src/core + src/faculties: a new code path that asserts protection without
// deriving it from `job.welfareClaimed` (and threading the granting job id) would
// forge the welfare guarantee, so it must fail this test until allowlisted.

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(THIS_DIR, '..', '..');
const SCAN_ROOTS = [join(SRC_ROOT, 'core'), join(SRC_ROOT, 'faculties')];

// The sanctioned welfare chain, agent-side:
//   post-turn-runtime (AUTHORITY: derives from job.welfareClaimed + job.jobId)
//     → extraction / extraction-orchestrator (memory extraction work spec)
//     → emotion-self-model-runtime / appraisal (emotion appraisal work spec)
// Each forwards the flag+grant it was handed; only post-turn-runtime originates
// it from store-backed welfare state.
const ALLOWLIST = new Set<string>([
  'core/agent/background-work/post-turn-runtime.ts',
  'core/agent/substrate-agent/emotion-self-model-runtime.ts',
  'core/emotion/appraisal.ts',
  'faculties/memory/extraction.ts',
  'faculties/memory/extraction/orchestrator.ts',
]);

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
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

// An object-literal SET of the field (`preemptionProtected: <expr>`), not a type
// declaration (`preemptionProtected?: ...`) nor a dot/destructure READ.
const SETTER = /\b(?:preemptionProtected|welfareGrantJobId)\s*:/;
const TYPE_FIELD = /\b(?:preemptionProtected|welfareGrantJobId)\s*\?:/;

describe('preemptionProtected/welfareGrantJobId setter enforcement (fxt1)', () => {
  const files = SCAN_ROOTS.flatMap(listTsFiles);

  it('finds source to scan', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('only the sanctioned welfare path sets preemptionProtected / welfareGrantJobId', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split('\\').join('/');
      if (ALLOWLIST.has(rel)) continue;
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (TYPE_FIELD.test(line)) return;
        if (SETTER.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `preemptionProtected/welfareGrantJobId may only be set by the sanctioned welfare path:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the authority derives the flag from store-backed welfare state', () => {
    const source = readFileSync(
      join(SRC_ROOT, 'core/agent/background-work/post-turn-runtime.ts'),
      'utf8',
    );
    // The originating setter pairs the flag with the granting store job id and
    // keys both off welfareClaimed — the property the gateway re-verifies.
    expect(source).toContain('welfareGrantJobId: job.jobId');
    expect(source).toContain('job.welfareClaimed');
  });
});

#!/usr/bin/env node

// Pinned Trivy security gate for the surfaces OSV and Semgrep do not own:
// rendered Helm/Kubernetes misconfiguration (`config` mode) and immutable built
// container images (`image` mode).
//
// Supply-chain posture (do not "fix" by chasing a newer tag): the image below is
// pinned by immutable digest to Trivy v0.72.0, the reproduced post-incident
// release (the Trivy ecosystem suffered a March 2026 credential compromise, so
// only an explicit digest is trusted). The binary at this digest reports
// `Version: 0.72.0`, verified at runtime by `interpretTrivyVersion`; a version
// drift fails closed before any scan runs. Every invocation is tokenless and
// passes `--disable-telemetry` and `--skip-version-check`; no repository or
// registry credential is ever handed to Trivy.
//
// Config mode renders the repo-authoritative Helm chart with real Helm and
// representative fail-closed values into a per-template directory, then scans the
// rendered YAML for Kubernetes/Helm misconfiguration at HIGH,CRITICAL with
// `--exit-code 1`. A missing Helm binary, render failure, empty render, missing
// ignore file, an expired ignore entry, or a scanner error fails the gate
// (fail closed).
//
// Image mode scans an exported image archive (`--input <tar>`, no Docker socket
// mount) or an exact remote digest (`registry/repo@sha256:...`) for OS/library
// vulnerabilities at HIGH,CRITICAL with `--exit-code 1`. Vulnerability databases
// are mutable feeds: the periodic rescan workflow refreshes them on every run and
// the feed policy is documented in docs/operations.md, so advisories that land
// after build time are caught rather than silently frozen.
//
// The .trivyignore.yaml exceptions are exact (scoped to a single template path
// and rule) and expiring. Trivy 0.72.0 does not itself enforce the `expiry`
// field for misconfiguration ignores, so this wrapper enforces it: an entry that
// is missing an expiry, malformed, or past its expiry date fails the gate closed
// and forces a fresh human review instead of an indefinite silent suppression.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TRIVY_IMAGE =
  'ghcr.io/aquasecurity/trivy@sha256:c6e969c5662a546ad5de4a73c2a6b7a7c627f86d916903e175aa623af5b97ada';
export const TRIVY_VERSION = '0.72.0';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chartDir = resolve(repoRoot, 'deploy/helm/psfn');

// The repo-authoritative representative render. These mirror the fail-closed,
// non-fleet contract values used by scripts/verify-helm-chart.mjs and are the
// exact inputs under which the HIGH IaC baseline was reproduced. The chart's
// required .Files content (recovery-chart.sha256) is read straight from the
// chart directory by real Helm, so no fixture files are needed.
export const TRIVY_HELM_RENDER_ARGS = Object.freeze([
  '--namespace', 'psfn-test',
  '--skip-schema-validation',
  '--set', 'fleet.enabled=false',
  '--set', 'fleetAuth.enabled=false',
  '--set', 'ingress.gateway.tls.enabled=false',
  '--set-string', 'ingress.gateway.tls.secretName=',
  '--set', 'ingress.garden.enabled=true',
  '--set-string', 'runtime.systemDataDir=/app/system-data',
  '--set-string', 'runtime.companionDataDir=/app/companion-data',
  '--set-string', 'runtime.workspacePath=/app/workspace',
  '--set-string', 'runtime.logsDir=/app/logs',
  '--set-string', 'runtime.tempDir=/app/tmp',
  '--set-string', 'runtime.backupsDir=/app/backups',
  '--set-string', 'runtime.characterCardPath=/app/companion-data/companion.json',
]);

// The fleet topology is the DEFAULT shipped posture (values.yaml
// fleet.enabled=true, and workloads.yaml suppresses the non-fleet agent when
// fleet is on), so scanning only the non-fleet render above would leave
// fleet-agents.yaml — the container that actually ships — permanently
// unscanned. This second pass renders the fleet topology so a misconfiguration
// regression in fleet-agents.yaml (e.g. a securityContext that drops
// readOnlyRootFilesystem) fails the gate. Fleet rendering fails closed unless
// fleetAuth is enabled and the runtime.* paths are derived from
// fleet.runtimeRoot (/runtime) and the first registered companion, so these are
// the minimal valid fixtures — mirrored from fleetGardenRenderArgs in
// scripts/verify-helm-chart.mjs. The default single-companion fleet from
// values.yaml is used (companionId 11111111-…-111111111111).
const FLEET_PRIMARY_COMPANION_ID = '11111111-1111-4111-8111-111111111111';
export const TRIVY_FLEET_HELM_RENDER_ARGS = Object.freeze([
  '--namespace', 'psfn-test',
  '--skip-schema-validation',
  '--set', 'fleet.enabled=true',
  '--set', 'fleetAuth.enabled=true',
  '--set', 'ingress.gateway.tls.enabled=true',
  '--set-string', 'ingress.gateway.tls.secretName=fleet-gateway-tls',
  '--set', 'ingress.garden.enabled=true',
  '--set-string', `runtime.companionId=${FLEET_PRIMARY_COMPANION_ID}`,
  '--set-string', 'runtime.systemDataDir=/runtime/system-data',
  '--set-string', `runtime.companionDataDir=/runtime/companions/${FLEET_PRIMARY_COMPANION_ID}`,
  '--set-string', `runtime.characterCardPath=/runtime/companions/${FLEET_PRIMARY_COMPANION_ID}/companion.json`,
  '--set-string', `runtime.workspacePath=/runtime/workspaces/personal/${FLEET_PRIMARY_COMPANION_ID}`,
  '--set-string', 'runtime.logsDir=/runtime/logs',
  '--set-string', 'runtime.tempDir=/runtime/tmp',
  '--set-string', 'runtime.backupsDir=/runtime/backups',
]);

// Every render pass the config gate must scan. Both topologies must pass the
// HIGH,CRITICAL misconfiguration scan; a finding in either fails the gate.
export const TRIVY_HELM_RENDER_PASSES = Object.freeze([
  Object.freeze({ name: 'non-fleet', args: TRIVY_HELM_RENDER_ARGS }),
  Object.freeze({ name: 'fleet', args: TRIVY_FLEET_HELM_RENDER_ARGS }),
]);

export const TRIVY_IGNORE_FILE = resolve(repoRoot, '.trivyignore.yaml');

export function interpretTrivyVersion(output, expected = TRIVY_VERSION) {
  const text = String(output);
  // Match a whole-token version so `0.72.0` never satisfies `0.72.01`.
  if (!new RegExp(`(?:^|\\s)${expected.replace(/\./g, '\\.')}(?:\\s|$)`).test(text)) {
    throw new Error(
      `Pinned trivy image reported an unexpected version (expected ${expected}): ${text.trim() || '<empty>'}`,
    );
  }
  return expected;
}

export function parseTrivyArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  if (mode !== 'config' && mode !== 'image') {
    throw new Error(`trivy wrapper requires a mode ('config' or 'image'), got: ${mode ?? '<none>'}`);
  }
  const opts = { mode, input: '', image: '' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--input=')) opts.input = arg.slice('--input='.length);
    else if (arg === '--input') opts.input = args[(i += 1)];
    else if (arg.startsWith('--image=')) opts.image = arg.slice('--image='.length);
    else if (arg === '--image') opts.image = args[(i += 1)];
    else throw new Error(`Unknown trivy wrapper flag: ${arg}`);
  }
  if (mode === 'image' && !opts.input && !opts.image) {
    throw new Error('trivy image scan requires --input <archive.tar> or --image <ref@sha256:...>');
  }
  if (mode === 'image' && opts.input && opts.image) {
    throw new Error('trivy image scan takes exactly one of --input or --image, not both');
  }
  if (mode === 'image' && opts.image && !/@sha256:[0-9a-f]{64}$/.test(opts.image)) {
    throw new Error(`trivy image --image must be an exact digest ref (…@sha256:<64 hex>): ${opts.image}`);
  }
  return opts;
}

// Parse the constrained `misconfigurations:` list out of .trivyignore.yaml
// without a YAML dependency (this wrapper stays runnable in CI with no npm ci,
// like the OSV and zizmor gates). The schema this repo owns is fixed: a top-level
// `misconfigurations:` sequence whose items carry `id`, `paths` (a nested `- `
// sequence), and `expiry` at four-space indentation. Anything that does not match
// that exact shape is a loud failure, never a silent skip. Block scalars for
// `statement` (six-space indented) are ignored by construction.
export function parseTrivyIgnoreEntries(ignoreText) {
  const lines = String(ignoreText).split('\n');
  let inSection = false;
  const entries = [];
  let current = null;
  let inPaths = false;
  const flush = () => { if (current) { entries.push(current); current = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^misconfigurations:\s*(\[\s*\])?\s*$/.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    if (/^\S/.test(line)) { flush(); inSection = false; continue; } // dedent out of section
    const entryStart = line.match(/^ {2}-\s+id:\s*(\S+)\s*$/);
    if (entryStart) {
      flush();
      current = { id: entryStart[1], expiry: undefined, paths: [] };
      inPaths = false;
      continue;
    }
    if (!current) {
      throw new Error(`.trivyignore.yaml misconfigurations entry must begin with "  - id:"; got: ${line.trim()}`);
    }
    const expiry = line.match(/^ {4}expiry:\s*(\S+)\s*$/);
    if (expiry) { current.expiry = expiry[1]; inPaths = false; continue; }
    const pathsLine = line.match(/^ {4}paths:\s*(\[.*\])?\s*$/);
    if (pathsLine) {
      inPaths = true;
      if (pathsLine[1]) {
        // Inline flow sequence: paths: ["a", "b"]
        for (const item of pathsLine[1].matchAll(/"([^"]+)"|'([^']+)'/g)) {
          current.paths.push(item[1] ?? item[2]);
        }
        inPaths = false;
      }
      continue;
    }
    const pathItem = line.match(/^ {6}-\s*"?([^"]+)"?\s*$/);
    if (inPaths && pathItem) { current.paths.push(pathItem[1]); continue; }
    if (/^ {4}\S/.test(line)) { inPaths = false; continue; } // some other 4-space key (e.g. statement:)
    // deeper-indented block scalar content (statement) — skip while not in paths.
  }
  flush();
  return entries;
}

// Enforce the expiry contract that Trivy itself does not enforce for
// misconfiguration ignores. Every entry must carry a parseable, future expiry and
// explicit paths; anything missing/malformed/past/unscoped fails closed so a
// stale or broad suppression can never silently outlive its review window.
export function assertIgnoresNotExpired(ignoreText, now = new Date()) {
  const entries = parseTrivyIgnoreEntries(ignoreText);
  if (entries.length === 0) {
    throw new Error('.trivyignore.yaml must declare at least one misconfigurations entry (fail closed on an empty ignore contract)');
  }
  const expired = [];
  for (const entry of entries) {
    const id = entry.id ?? '<no id>';
    if (typeof entry.expiry !== 'string' || entry.expiry.trim() === '') {
      throw new Error(`.trivyignore.yaml entry ${id} is missing a required expiry date`);
    }
    const when = new Date(entry.expiry);
    if (Number.isNaN(when.getTime())) {
      throw new Error(`.trivyignore.yaml entry ${id} has an unparseable expiry: ${entry.expiry}`);
    }
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      throw new Error(`.trivyignore.yaml entry ${id} must be scoped to explicit paths (broad rule suppression is forbidden)`);
    }
    if (when.getTime() <= now.getTime()) expired.push(`${id} (expired ${entry.expiry})`);
  }
  if (expired.length > 0) {
    throw new Error(
      `.trivyignore.yaml has expired exception(s): ${expired.join(', ')}. Re-verify and re-scope or remediate; refusing to scan with a stale suppression.`,
    );
  }
  return entries.length;
}

export function buildTrivyConfigArgs({ scanMount, ignoreMount }) {
  return [
    'run', '--rm', '--platform', 'linux/amd64',
    '--volume', `${scanMount}:/scan:ro`,
    '--volume', `${ignoreMount}:/cfg/.trivyignore.yaml:ro`,
    '--workdir', '/scan',
    TRIVY_IMAGE, 'config', '/scan',
    '--severity', 'HIGH,CRITICAL',
    '--misconfig-scanners', 'kubernetes,helm,dockerfile',
    '--ignorefile', '/cfg/.trivyignore.yaml',
    '--disable-telemetry', '--skip-version-check',
    '--exit-code', '1',
  ];
}

export function buildTrivyImageArgs({ input = '', image = '' }) {
  const mount = ['run', '--rm', '--platform', 'linux/amd64'];
  const base = [
    'image',
    '--scanners', 'vuln',
    '--severity', 'HIGH,CRITICAL',
    '--pkg-types', 'os,library',
    '--disable-telemetry', '--skip-version-check',
    '--exit-code', '1',
  ];
  if (input) {
    // Exported archive: mount the tar read-only and scan it. No Docker socket.
    return [
      ...mount, '--volume', `${input}:/scan/image.tar:ro`, '--workdir', '/scan',
      TRIVY_IMAGE, ...base, '--input', '/scan/image.tar',
    ];
  }
  // Exact remote digest: Trivy pulls the manifest itself (no Docker socket).
  return [...mount, TRIVY_IMAGE, ...base, '--offline-scan', image];
}

function realDocker(args, { capture = false } = {}) {
  const result = spawnSync(
    'docker',
    args,
    capture ? { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' } : { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

// Render the authoritative chart into a fresh per-template directory using the
// supplied per-pass render args. Fails closed on a missing Helm binary, render
// failure, or empty output.
function realHelmRender(outDir, renderArgs = TRIVY_HELM_RENDER_ARGS) {
  let stdout;
  try {
    stdout = execFileSync(
      'helm',
      ['template', 'psfn', chartDir, ...renderArgs, '--output-dir', outDir],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const detail = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`Helm render failed; refusing to scan: ${detail}`);
  }
  return stdout;
}

export function runTrivy({
  argv = process.argv.slice(2),
  runDocker = realDocker,
  helmRender = realHelmRender,
  readIgnore = () => readFileSync(TRIVY_IGNORE_FILE, 'utf8'),
  now = new Date(),
} = {}) {
  const opts = parseTrivyArgs(argv);

  // Confirm the pinned image really is 0.72.0 before trusting any scan. Capture
  // stdout so this line never pollutes a report written to stdout.
  const probe = runDocker(['run', '--rm', '--platform', 'linux/amd64', TRIVY_IMAGE, '--version'], {
    capture: true,
  });
  if (probe.status !== 0) {
    process.stderr.write('trivy version probe failed; refusing to scan\n');
    return probe.status || 1;
  }
  interpretTrivyVersion(probe.stdout);
  process.stderr.write(`trivy ${TRIVY_VERSION} verified\n`);

  if (opts.mode === 'image') {
    return runDocker(buildTrivyImageArgs({ input: opts.input, image: opts.image })).status;
  }

  // config mode: enforce the ignore expiry contract, then render+scan every
  // topology pass. Both the non-fleet and the (default-shipped) fleet render
  // must pass HIGH,CRITICAL; a finding in either fails the gate closed.
  const ignoreText = readIgnore();
  assertIgnoresNotExpired(ignoreText, now);

  for (const pass of TRIVY_HELM_RENDER_PASSES) {
    const outDir = mkdtempSync(join(tmpdir(), `psfn-trivy-render-${pass.name}-`));
    try {
      helmRender(outDir, pass.args);
      const renderedRoot = join(outDir, 'psfn', 'templates');
      if (!existsSync(renderedRoot)) {
        throw new Error(
          `Helm ${pass.name} render produced no templates directory at ${renderedRoot}; refusing to scan`,
        );
      }
      const status = runDocker(
        buildTrivyConfigArgs({ scanMount: outDir, ignoreMount: TRIVY_IGNORE_FILE }),
      ).status;
      if (status !== 0) return status;
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  return runTrivy({ argv });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = resolve(repoRoot, 'deploy/helm/psfn');
const sourceDir = resolve(repoRoot, 'companion_docs');
const packagedDir = resolve(chartDir, 'overlays/companion-library');
const fileNames = [
  'companion-library-manifest.json',
  'live_verification_checklist.md',
  'privacy-boundary-reference.md',
  'welcome.md',
];

function fail(message) {
  throw new Error(`Helm companion-library verification: ${message}`);
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function render(extraArgs = []) {
  return execFileSync('helm', [
    'template',
    'psfn',
    chartDir,
    '--namespace',
    'psfn-test',
    ...extraArgs,
  ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function parsedDocuments(yaml, label) {
  const documents = parseAllDocuments(yaml);
  const errors = documents.flatMap(document => document.errors);
  if (errors.length > 0) fail(`${label} render is malformed: ${errors[0].message}`);
  return documents.map(document => document.toJS()).filter(Boolean);
}

const canonical = Object.fromEntries(fileNames.map(fileName => {
  const source = readText(resolve(sourceDir, fileName));
  const packaged = readText(resolve(packagedDir, fileName));
  if (packaged !== source) fail(`packaged ${fileName} differs from companion_docs/${fileName}`);
  return [fileName, source];
}));

const manifest = JSON.parse(canonical['companion-library-manifest.json']);
if (manifest.schemaVersion !== 1 || manifest.bundleVersion !== 'companion-library-v2') {
  fail('canonical manifest identity changed unexpectedly');
}
const manifestPaths = manifest.files.map(entry => entry.path).sort();
const expectedManifestPaths = fileNames.filter(name => name.endsWith('.md')).sort();
if (JSON.stringify(manifestPaths) !== JSON.stringify(expectedManifestPaths)) {
  fail('manifest file list does not match the packaged Markdown files');
}
for (const entry of manifest.files) {
  const actual = createHash('sha256').update(canonical[entry.path]).digest('hex');
  if (actual !== entry.sha256) fail(`manifest digest is stale for ${entry.path}`);
}

const defaultDocuments = parsedDocuments(render(), 'default');
if (defaultDocuments.some(document => (
  document.kind === 'ConfigMap' && document.metadata?.name === 'psfn-companion-library'
))) {
  fail('inactive default unexpectedly renders psfn-companion-library');
}

const enabledDocuments = parsedDocuments(
  render(['--set', 'companionLibrary.enabled=true']),
  'enabled',
);
const configMaps = enabledDocuments.filter(document => (
  document.kind === 'ConfigMap' && document.metadata?.name === 'psfn-companion-library'
));
if (configMaps.length !== 1) fail(`enabled render contains ${configMaps.length} companion ConfigMaps`);
if (configMaps[0].metadata.labels?.['app.kubernetes.io/managed-by'] !== 'Helm') {
  fail('ConfigMap is missing Helm ownership labels');
}
const actualKeys = Object.keys(configMaps[0].data ?? {}).sort();
if (JSON.stringify(actualKeys) !== JSON.stringify([...fileNames].sort())) {
  fail(`ConfigMap keys differ: ${actualKeys.join(', ')}`);
}
for (const fileName of fileNames) {
  if (configMaps[0].data[fileName] !== canonical[fileName]) {
    fail(`rendered ConfigMap data differs for ${fileName}`);
  }
}

console.log('Helm companion-library bundle verification passed.');

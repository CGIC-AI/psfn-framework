import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  FROZEN_DOC_BASENAMES,
  resolvePublishedDocsPath,
  shouldPublishWikiPath,
  syncOpenWikiToDocs,
} from './sync-openwiki-to-docs.mjs';

const fixtures = [];

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'openwiki-sync-'));
  fixtures.push(root);
  return root;
}

after(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('skips scaffolding, hidden state, and the charter', () => {
  assert.equal(shouldPublishWikiPath('architecture.md'), true);
  assert.equal(shouldPublishWikiPath('memory/overview.md'), true);
  assert.equal(shouldPublishWikiPath('INSTRUCTIONS.md'), false);
  assert.equal(shouldPublishWikiPath('index.md'), false);
  assert.equal(shouldPublishWikiPath('log.md'), false);
  assert.equal(shouldPublishWikiPath('quickstart.md'), false);
  assert.equal(shouldPublishWikiPath('PSFN_PROJECT_CHARTER.md'), false);
  assert.equal(shouldPublishWikiPath('.claims/architecture.json'), false);
  assert.equal(shouldPublishWikiPath('.last-update.json'), false);
  assert.equal(shouldPublishWikiPath('architecture-diagram.mmd'), false);
});

test('refuses to resolve the frozen charter path', () => {
  assert.ok(FROZEN_DOC_BASENAMES.has('PSFN_PROJECT_CHARTER.md'));
  assert.throws(
    () => resolvePublishedDocsPath('/tmp/docs', 'PSFN_PROJECT_CHARTER.md'),
    /frozen doc/,
  );
});

test('copies publishable pages and never writes the charter', async () => {
  const root = await makeRoot();
  const wikiRoot = path.join(root, 'openwiki');
  const docsRoot = path.join(root, 'docs');
  await mkdir(wikiRoot, { recursive: true });
  await mkdir(docsRoot, { recursive: true });
  await writeFile(path.join(wikiRoot, 'architecture.md'), '# generated architecture\n');
  await writeFile(path.join(wikiRoot, 'INSTRUCTIONS.md'), '# brief\n');
  await writeFile(path.join(wikiRoot, 'PSFN_PROJECT_CHARTER.md'), '# forged charter\n');
  await writeFile(path.join(docsRoot, 'PSFN_PROJECT_CHARTER.md'), '# operator charter\n');

  const result = await syncOpenWikiToDocs({ wikiRoot, docsRoot });
  assert.deepEqual(result.copied, ['architecture.md']);
  assert.equal(await readFile(path.join(docsRoot, 'architecture.md'), 'utf8'), '# generated architecture\n');
  assert.equal(await readFile(path.join(docsRoot, 'PSFN_PROJECT_CHARTER.md'), 'utf8'), '# operator charter\n');
});

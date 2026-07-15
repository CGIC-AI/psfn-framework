import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { JournalEntry } from '../../../core/session/types.js';
import { SessionStore } from '../../sessions/store.js';
import { makeRolledFilePath } from '../../sessions/store/channel-filenames.js';
import {
  pendingJournalChainRewriteManifestPath,
  recoverJournalChainRewrite,
  rewriteJournalChainTransaction,
} from './chain-transaction.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function createHarness(): { dir: string; rootPath: string; segmentPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-chain-transaction-'));
  roots.push(dir);
  const rootPath = join(dir, 'session.jsonl');
  const segmentPath = join(dir, 'session.segment-0002.jsonl');
  writeFileSync(rootPath, 'old root\n', 'utf8');
  writeFileSync(segmentPath, 'old segment\n', 'utf8');
  return { dir, rootPath, segmentPath };
}

function entry(id: number): JournalEntry {
  return {
    type: 'message',
    id,
    channelId: 'api:transaction',
    role: id % 2 === 0 ? 'assistant' : 'user',
    content: `entry ${id}`,
    timestamp: id,
  };
}

function writeEntries(filePath: string, entries: readonly JournalEntry[]): void {
  writeFileSync(filePath, `${entries.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8');
}

function transactionArtifacts(dir: string): string[] {
  return readdirSync(dir).filter(filename => (
    filename.endsWith('.staged')
    || filename.endsWith('.backup')
    || filename.endsWith('.chain-rewrite-manifest.json')
  ));
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for child marker: ${filePath}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('journal chain rewrite transactions', () => {
  it('leaves every original untouched when staging a later segment fails', () => {
    const { dir, rootPath, segmentPath } = createHarness();

    expect(() => rewriteJournalChainTransaction({
      targetPaths: [rootPath, segmentPath],
      entriesByTarget: [[entry(1)], [entry(2)]],
      writeEntries: (filePath, entries) => {
        if (filePath.startsWith(segmentPath)) throw new Error('injected staging failure');
        writeEntries(filePath, entries);
      },
    })).toThrow('injected staging failure');

    expect(readFileSync(rootPath, 'utf8')).toBe('old root\n');
    expect(readFileSync(segmentPath, 'utf8')).toBe('old segment\n');
    expect(transactionArtifacts(dir)).toEqual([]);
  });

  it('rolls every target back from a prepared manifest after a partial install', () => {
    const { dir, rootPath, segmentPath } = createHarness();
    const transactionId = 'prepared-test';
    const files = [rootPath, segmentPath].map(targetPath => ({
      targetPath,
      stagedPath: `${targetPath}.${transactionId}.staged`,
      backupPath: `${targetPath}.${transactionId}.backup`,
    }));
    for (const file of files) {
      copyFileSync(file.targetPath, file.backupPath);
      writeFileSync(file.stagedPath, `new ${file.targetPath}\n`, 'utf8');
    }
    writeFileSync(rootPath, 'partially installed root\n', 'utf8');
    writeFileSync(pendingJournalChainRewriteManifestPath(rootPath), JSON.stringify({
      version: 1,
      transactionId,
      phase: 'prepared',
      rootPath,
      files,
    }), 'utf8');

    recoverJournalChainRewrite(rootPath);

    expect(readFileSync(rootPath, 'utf8')).toBe('old root\n');
    expect(readFileSync(segmentPath, 'utf8')).toBe('old segment\n');
    expect(transactionArtifacts(dir)).toEqual([]);
  });

  it('cleans sensitive artifacts left by abrupt death during staging', () => {
    const { dir, rootPath, segmentPath } = createHarness();
    const transactionId = 'staging-death-test';
    const files = [rootPath, segmentPath].map(targetPath => ({
      targetPath,
      stagedPath: `${targetPath}.${transactionId}.staged`,
      backupPath: `${targetPath}.${transactionId}.backup`,
    }));
    writeFileSync(pendingJournalChainRewriteManifestPath(rootPath), JSON.stringify({
      version: 1,
      transactionId,
      phase: 'staging',
      rootPath,
      files,
    }), 'utf8');
    copyFileSync(rootPath, files[0]!.backupPath);
    writeFileSync(files[0]!.stagedPath, 'partially staged replacement\n', 'utf8');

    recoverJournalChainRewrite(rootPath);

    expect(readFileSync(rootPath, 'utf8')).toBe('old root\n');
    expect(readFileSync(segmentPath, 'utf8')).toBe('old segment\n');
    expect(transactionArtifacts(dir)).toEqual([]);
  });

  it('recovers a published staging manifest after the rewriting process is killed', async () => {
    const { dir, rootPath, segmentPath } = createHarness();
    const markerPath = join(dir, 'child-staged.marker');
    const childSource = `
      const { writeFileSync } = await import('node:fs');
      const { rewriteJournalChainTransaction } = await import(process.env.TRANSACTION_MODULE_URL);
      const rootPath = process.env.ROOT_PATH;
      const segmentPath = process.env.SEGMENT_PATH;
      const markerPath = process.env.MARKER_PATH;
      rewriteJournalChainTransaction({
        targetPaths: [rootPath, segmentPath],
        entriesByTarget: [[{ type: 'message', id: 1, channelId: 'api:child', role: 'user', content: 'root', timestamp: 1 }], [{ type: 'message', id: 2, channelId: 'api:child', role: 'assistant', content: 'segment', timestamp: 2 }]],
        writeEntries: (filePath, entries) => {
          writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\\n') + '\\n', 'utf8');
          if (filePath.startsWith(segmentPath)) {
            writeFileSync(markerPath, 'ready', 'utf8');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
        },
      });
    `;
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      childSource,
    ], {
      env: {
        ...process.env,
        TRANSACTION_MODULE_URL: new URL('./chain-transaction.ts', import.meta.url).href,
        ROOT_PATH: rootPath,
        SEGMENT_PATH: segmentPath,
        MARKER_PATH: markerPath,
      },
      stdio: 'ignore',
    });
    const childExit = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      await waitForFile(markerPath);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await childExit;
    }

    expect(existsSync(pendingJournalChainRewriteManifestPath(rootPath))).toBe(true);
    expect(transactionArtifacts(dir).some(filename => filename.endsWith('.backup'))).toBe(true);
    recoverJournalChainRewrite(rootPath);
    expect(readFileSync(rootPath, 'utf8')).toBe('old root\n');
    expect(readFileSync(segmentPath, 'utf8')).toBe('old segment\n');
    expect(transactionArtifacts(dir)).toEqual([]);
  });

  it('finishes rolled-back cleanup when some backups were already deleted', () => {
    const { dir, rootPath, segmentPath } = createHarness();
    const transactionId = 'rolled-back-cleanup-test';
    const files = [rootPath, segmentPath].map(targetPath => ({
      targetPath,
      stagedPath: `${targetPath}.${transactionId}.staged`,
      backupPath: `${targetPath}.${transactionId}.backup`,
    }));
    copyFileSync(rootPath, files[0]!.backupPath);
    writeFileSync(files[0]!.stagedPath, 'leftover staged replacement\n', 'utf8');
    writeFileSync(pendingJournalChainRewriteManifestPath(rootPath), JSON.stringify({
      version: 1,
      transactionId,
      phase: 'rolled_back',
      rootPath,
      files,
    }), 'utf8');

    recoverJournalChainRewrite(rootPath);

    expect(readFileSync(rootPath, 'utf8')).toBe('old root\n');
    expect(readFileSync(segmentPath, 'utf8')).toBe('old segment\n');
    expect(transactionArtifacts(dir)).toEqual([]);
  });

  it('keeps installed targets and finishes cleanup for a committed manifest', () => {
    const { dir, rootPath, segmentPath } = createHarness();
    const transactionId = 'committed-test';
    const files = [rootPath, segmentPath].map(targetPath => ({
      targetPath,
      stagedPath: `${targetPath}.${transactionId}.staged`,
      backupPath: `${targetPath}.${transactionId}.backup`,
    }));
    for (const file of files) {
      copyFileSync(file.targetPath, file.backupPath);
      writeFileSync(file.targetPath, `committed ${file.targetPath}\n`, 'utf8');
    }
    writeFileSync(pendingJournalChainRewriteManifestPath(rootPath), JSON.stringify({
      version: 1,
      transactionId,
      phase: 'committed',
      rootPath,
      files,
    }), 'utf8');

    recoverJournalChainRewrite(rootPath);

    expect(readFileSync(rootPath, 'utf8')).toContain('committed');
    expect(readFileSync(segmentPath, 'utf8')).toContain('committed');
    expect(transactionArtifacts(dir)).toEqual([]);
  });

  it('rolls back when a fault lands after the prepared phase is durable', () => {
    const { dir, rootPath, segmentPath } = createHarness();

    expect(() => rewriteJournalChainTransaction({
      targetPaths: [rootPath, segmentPath],
      entriesByTarget: [[entry(1)], [entry(2)]],
      writeEntries,
      onDurablePhase: (phase) => {
        if (phase === 'prepared') throw new Error('injected power boundary fault');
      },
    })).toThrow('injected power boundary fault');

    expect(readFileSync(rootPath, 'utf8')).toBe('old root\n');
    expect(readFileSync(segmentPath, 'utf8')).toBe('old segment\n');
    expect(transactionArtifacts(dir)).toEqual([]);
  });

  it('keeps the durable installed generation when a fault lands after commit', () => {
    const { dir, rootPath, segmentPath } = createHarness();

    expect(() => rewriteJournalChainTransaction({
      targetPaths: [rootPath, segmentPath],
      entriesByTarget: [[entry(1)], [entry(2)]],
      writeEntries,
      onDurablePhase: (phase) => {
        if (phase === 'committed') throw new Error('injected post-commit fault');
      },
    })).not.toThrow();

    expect(readFileSync(rootPath, 'utf8')).toContain('"id":1');
    expect(readFileSync(segmentPath, 'utf8')).toContain('"id":2');
    expect(transactionArtifacts(dir)).toEqual([]);
  });

  it('rejects a manifest that names a target outside the journal directory', () => {
    const { dir, rootPath } = createHarness();
    const outsidePath = join(tmpdir(), `psfn-outside-${process.pid}.jsonl`);
    const transactionId = 'unsafe-test';
    writeFileSync(outsidePath, 'must remain\n', 'utf8');
    try {
      writeFileSync(pendingJournalChainRewriteManifestPath(rootPath), JSON.stringify({
        version: 1,
        transactionId,
        phase: 'committed',
        rootPath,
        files: [{
          targetPath: outsidePath,
          stagedPath: `${outsidePath}.${transactionId}.staged`,
          backupPath: `${outsidePath}.${transactionId}.backup`,
        }],
      }), 'utf8');

      expect(() => recoverJournalChainRewrite(rootPath)).toThrow('Unsafe L0 chain rewrite manifest path');
      expect(readFileSync(outsidePath, 'utf8')).toBe('must remain\n');
      expect(existsSync(pendingJournalChainRewriteManifestPath(rootPath))).toBe(true);
      expect(readdirSync(dir)).toContain('session.jsonl.chain-rewrite-manifest.json');
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  it('is recovered under the stable journal lock during SessionStore startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-chain-startup-recovery-'));
    roots.push(dir);
    const rootPath = join(dir, '20260325_api-transaction_user_000001.jsonl');
    const segmentPath = makeRolledFilePath(rootPath, 2);
    writeEntries(rootPath, [entry(1)]);
    writeEntries(segmentPath, [entry(2)]);
    const transactionId = 'startup-test';
    const files = [rootPath, segmentPath].map(targetPath => ({
      targetPath,
      stagedPath: `${targetPath}.${transactionId}.staged`,
      backupPath: `${targetPath}.${transactionId}.backup`,
    }));
    for (const file of files) {
      copyFileSync(file.targetPath, file.backupPath);
      writeFileSync(file.stagedPath, 'staged replacement\n', 'utf8');
    }
    writeEntries(rootPath, [{ ...entry(1), content: 'partially installed' }]);
    writeFileSync(pendingJournalChainRewriteManifestPath(rootPath), JSON.stringify({
      version: 1,
      transactionId,
      phase: 'prepared',
      rootPath,
      files,
    }), 'utf8');

    const store = new SessionStore(dir);

    expect(store.getRecent('api:transaction', 10).map(item => item.content)).toEqual([
      'entry 1',
      'entry 2',
    ]);
    expect(transactionArtifacts(dir)).toEqual([]);
  });
});

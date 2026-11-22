import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createOptionalJournalAutoPublisher } from './journal-runtime.js';

describe('createOptionalJournalAutoPublisher (ik47b.16)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enables local workspace markdown auto-publish even when legacy obsidianAutoPublish is false', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'journal-runtime-test-'));
    const config = fromPartial<SubstrateConfig>({
      vault: {
        obsidianAutoPublish: false,
      },
    });

    const publisher = createOptionalJournalAutoPublisher(tempDir, config);
    await publisher.publishReflection({
      templateId: 'daily-review',
      templateName: 'Daily Review',
      mode: 'freeform',
      reflection: 'Quiet note written to the local workspace markdown journal.',
      createdAt: new Date('2026-04-20T12:00:00.000Z'),
    });

    const dailyDir = join(tempDir, 'journal', 'reflections', 'daily');
    expect(existsSync(dailyDir)).toBe(true);
    const files = readdirSync(dailyDir).filter(file => file.endsWith('.md'));
    expect(files).toHaveLength(1);
    const content = readFileSync(join(dailyDir, files[0] as string), 'utf-8');
    expect(content).toContain('template: daily-review');
    expect(content).toContain('Quiet note written to the local workspace markdown journal.');
  });
});

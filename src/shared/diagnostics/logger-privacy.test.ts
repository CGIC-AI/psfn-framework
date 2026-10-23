import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('redacts private sentinels before real console and file transports while preserving operational facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'logger-privacy-'));
  const filename = join(root, 'transport.log');
  try {
    const source = `
      import { logger } from './src/shared/logger.ts';
      import { transports, format } from 'winston';
      logger.add(new transports.File({ filename: process.env.PRIVACY_TEST_LOG }));
      logger.add(new transports.Console({format:format(info=>{
        process.stdout.write(JSON.stringify({stack:info.stack,cause:info.cause,splat:info[Symbol.for('splat')]})+'\\n');return info;
      })()}));
      logger.info('provider request completed', {
        requestId: 'request-public', durationMs: 17, status: 'success',
        userText: 'USER_PRIVATE_SENTINEL', assistantResponse: 'ASSISTANT_PRIVATE_SENTINEL',
        transcript: 'TRANSCRIPT_PRIVATE_SENTINEL', attachmentName: 'ATTACHMENT_PRIVATE_SENTINEL.png',
        sessionToken: 'SESSION_PRIVATE_SENTINEL', authorization: 'Bearer CREDENTIAL_PRIVATE_SENTINEL',
        detail: 'UNKNOWN_PRIVATE_SENTINEL', reason: 'REASON_PRIVATE_SENTINEL', input: 'INPUT_PRIVATE_SENTINEL',
        error: new Error('ERROR_PRIVATE_SENTINEL\\nINJECTED_LOG_RECORD\\u001b[31m')
      });
      logger.error('transport failed', { component: 'test\\r\\nINJECTED_COMPONENT', durationMs: 23 });
      logger.error(new Error('RAW_ERROR_PRIVATE_SENTINEL'));
      logger.end();
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: process.cwd(), env: { ...process.env, PRIVACY_TEST_LOG: filename, LOG_LEVEL: 'debug' }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    for (const output of [result.stdout + result.stderr, readFileSync(filename, 'utf8')]) {
      expect(output).not.toMatch(/PRIVATE_SENTINEL|\u001b|\r/);
      expect(output).not.toContain('\nINJECTED_');
      expect(output).toContain('request-public');
      expect(output).toContain('17');
      expect(output).toContain('provider request completed');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('sink failure fallback uses stable diagnostics through actual stderr even when filesystem errors contain private paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'SINK_PRIVATE_SENTINEL-'));
  try {
    const source = `
      import {logger,configureOperationalLogPersistence,closeOperationalLogPersistence,getOperationalLogDirectory} from './src/shared/logger.ts';
      import fs from 'node:fs';
      configureOperationalLogPersistence({logsDir:process.env.PRIVACY_TEST_ROOT,process:'gateway',retentionDays:30});
      closeOperationalLogPersistence();
      const directory=getOperationalLogDirectory();fs.renameSync(directory,directory+'-old');fs.writeFileSync(directory,'not a directory');
      try { logger.warn('sink unavailable'); } catch { /* the caller handles the failed write without printing its private Error */ }
      logger.end();
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: process.cwd(), env: { ...process.env, PRIVACY_TEST_ROOT: root }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Operational metadata append failed; inspect sink health');
    expect(result.stdout + result.stderr).not.toContain('SINK_PRIVATE_SENTINEL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

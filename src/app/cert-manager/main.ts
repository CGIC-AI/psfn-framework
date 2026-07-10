// ── Cert-manager sidecar entrypoint ──
//
// Standalone process: it shares nothing with the gateway/agent runtimes
// except `src/shared/` utilities, the logger, and the persistence path
// discipline. Run next to the gateway on the host (or as a sidecar
// container) and point API_TLS_* / satellite bundles at its managed outputs.
//
//   npm run cert-manager -- init     generate root CA + default config
//   npm run cert-manager             serve the issuance API + renewal loop
//
// See docs/certificates.md for the full bootstrap walkthrough.

import '../../shared/utils/load-dotenv.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  certManagerConfigPath,
  defaultCertManagerConfig,
  loadCertManagerConfig,
  parseCertManagerToken,
  resolveCertManagerStateDir,
  writeCertManagerConfig,
} from './config.js';
import { CertManagerService, initCertificateAuthority } from './service.js';
import {
  createCertManagerServer,
  listenCertManagerServer,
  stopCertManagerServer,
} from './server.js';
import { existsSync } from 'node:fs';

const log = createComponentLogger('CertManager');

async function runInit(stateDir: string): Promise<void> {
  const configPath = certManagerConfigPath(stateDir);
  let config;
  if (existsSync(configPath)) {
    // Re-running init with an existing config is fine (e.g. after moving CA
    // material aside for rotation); existing knobs are respected, and
    // initCertificateAuthority still refuses to overwrite live CA material.
    config = loadCertManagerConfig(stateDir);
    log.info('Using existing cert-manager config', { configPath });
  } else {
    config = defaultCertManagerConfig();
    writeCertManagerConfig(stateDir, config);
    log.info('Wrote default cert-manager config', { configPath });
  }
  const result = await initCertificateAuthority(stateDir, config);
  log.info('Generated private CA', {
    caCertPath: result.caCertPath,
    caKeyPath: result.caKeyPath,
    commonName: config.ca.commonName,
    validityDays: config.ca.validityDays,
  });
  log.info('Next: set CERT_MANAGER_TOKEN and start the sidecar with `npm run cert-manager`');
}

async function runServe(stateDir: string): Promise<void> {
  const token = parseCertManagerToken(process.env.CERT_MANAGER_TOKEN);
  const config = loadCertManagerConfig(stateDir);
  const service = await CertManagerService.open(stateDir, config, log);
  const server = createCertManagerServer({ service, config, token, logger: log });
  await listenCertManagerServer(server, config, log);
  log.info('cert-manager sidecar started', {
    stateDir,
    renewBeforeDays: config.defaults.renewBeforeDays,
    renewCheckIntervalMinutes: config.defaults.renewCheckIntervalMinutes,
  });

  // Renewal loop: one sweep at startup, then on the configured interval.
  // Sweep-level crashes are fatal-loud (error log) but keep the sidecar and
  // its API alive; per-certificate failures are handled inside the sweep.
  const sweep = async (): Promise<void> => {
    try {
      const result = await service.runRenewalSweep();
      if (result.renewed.length > 0 || result.failures.length > 0 || result.expiringUnmanaged.length > 0) {
        log.info('Renewal sweep finished', {
          checked: result.checked,
          renewed: result.renewed.length,
          failures: result.failures.length,
          expiringUnmanaged: result.expiringUnmanaged.length,
        });
      } else {
        log.debug('Renewal sweep finished; nothing due', { checked: result.checked });
      }
    } catch (error) {
      log.error('Renewal sweep crashed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await sweep();
  const interval = setInterval(() => { void sweep(); }, config.defaults.renewCheckIntervalMinutes * 60_000);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}; stopping cert-manager`);
    clearInterval(interval);
    void stopCertManagerServer(server)
      .then(() => {
        log.info('cert-manager stopped');
        process.exit(0);
      })
      .catch((error: unknown) => {
        log.error('cert-manager shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  const stateDir = resolveCertManagerStateDir(process.env);
  switch (command) {
    case 'init':
      await runInit(stateDir);
      return;
    case 'serve':
      await runServe(stateDir);
      return;
    default:
      throw new Error(`Unknown cert-manager command ${JSON.stringify(command)}; expected "init" or "serve"`);
  }
}

main().catch((error: unknown) => {
  log.error('cert-manager failed to start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

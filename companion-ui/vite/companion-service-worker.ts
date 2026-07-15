import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OutputBundle } from 'rollup';
import type { Plugin } from 'vite';

const CACHE_PREFIX = 'psfn-companion-ui-';
const BUILD_REVISION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const STATIC_APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-maskable.svg',
];

function configuredBuildRevision(): string | null {
  const revision = process.env.COMPANION_UI_BUILD_REVISION?.trim();
  if (!revision || revision === 'unknown') return null;
  if (!BUILD_REVISION_PATTERN.test(revision)) {
    throw new Error(
      'COMPANION_UI_BUILD_REVISION must be a 1-128 character token containing only '
      + 'letters, digits, period, underscore, or hyphen',
    );
  }
  return revision;
}

function hashBundle(bundle: OutputBundle): string {
  const hash = createHash('sha256');
  for (const fileName of Object.keys(bundle).sort()) {
    const output = bundle[fileName];
    if (!output) continue;
    hash.update(fileName);
    hash.update('\0');
    hash.update(output.type === 'chunk' ? output.code : output.source);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function replaceRequiredPlaceholder(source: string, placeholder: string, value: string): string {
  const first = source.indexOf(placeholder);
  if (first < 0 || source.indexOf(placeholder, first + placeholder.length) >= 0) {
    throw new Error(`Service-worker template must contain exactly one ${placeholder} placeholder`);
  }
  return source.replace(placeholder, value);
}

export function companionServiceWorker(): Plugin {
  let projectRoot = '';
  return {
    name: 'psfn-companion-service-worker',
    apply: 'build',
    configResolved(config) {
      projectRoot = config.root;
    },
    async generateBundle(_options, bundle) {
      const bundleHash = hashBundle(bundle);
      const configuredRevision = configuredBuildRevision();
      const buildRevision = configuredRevision
        ? `${configuredRevision}-${bundleHash}`
        : bundleHash;
      const assetUrls = Object.keys(bundle)
        .filter((fileName) => fileName.startsWith('assets/') && !fileName.endsWith('.map'))
        .sort()
        .map((fileName) => `/${fileName}`);
      const precacheUrls = [...STATIC_APP_SHELL, ...assetUrls];
      const template = await readFile(resolve(projectRoot, 'service-worker/sw.js'), 'utf8');
      const withCacheName = replaceRequiredPlaceholder(
        template,
        '__PSFN_COMPANION_UI_CACHE_NAME__',
        JSON.stringify(`${CACHE_PREFIX}${buildRevision}`),
      );
      const rendered = replaceRequiredPlaceholder(
        withCacheName,
        '__PSFN_COMPANION_UI_PRECACHE_URLS__',
        JSON.stringify(precacheUrls),
      );
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: rendered,
      });
    },
  };
}

#!/usr/bin/env node

// Garden behavioral sweep (Layer A) — see docs/shakedown.md. Drives the Garden
// admin SPA with Playwright and asserts behavior (expected copy present, no
// console/page errors), not HTTP 200s. Fail-closed config: admin base, admin
// token, the Playwright install root, and the output/artifact paths all come
// from the sourced shakedown env; there are no /mnt or previous-sprint defaults.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  requireEnv,
  requireEnvOneOf,
  optionalBoolEnv,
  optionalIntEnv,
  failClosedOnEnv,
} from './lib/env.mjs';

const CONFIG = (() => {
  try {
    return {
      adminBase: requireEnv('PSFN_ADMIN_BASE', 'Garden admin base URL'),
      adminToken: requireEnvOneOf(['ADMIN_TOKEN', 'PSFN_ADMIN_TOKEN'], 'Garden admin token'),
      browserProbeRoot: requireEnv('PSFN_BROWSER_PROBE_ROOT', 'directory with playwright installed'),
      artifactRoot: requireEnv('PSFN_SHAKEDOWN_ARTIFACT_ROOT', 'round artifact directory for screenshots'),
      outputPath: requireEnv('PSFN_UI_SWEEP_OUTPUT', 'Garden sweep result JSON path'),
    };
  } catch (error) {
    failClosedOnEnv(error);
    throw error;
  }
})();

const ADMIN_BASE = CONFIG.adminBase;
const ADMIN_TOKEN = CONFIG.adminToken;
const BROWSER_PROBE_ROOT = CONFIG.browserProbeRoot;
const ARTIFACT_ROOT = CONFIG.artifactRoot;
const OUTPUT_PATH = CONFIG.outputPath;
const NAVIGATION_TIMEOUT_MS = optionalIntEnv('PSFN_UI_SWEEP_TIMEOUT_MS', 30000);
const PAGE_SETTLE_MS = optionalIntEnv('PSFN_UI_SWEEP_SETTLE_MS', 1500);
const VIEWPORT_WIDTH = optionalIntEnv('PSFN_UI_SWEEP_WIDTH', 1440);
const VIEWPORT_HEIGHT = optionalIntEnv('PSFN_UI_SWEEP_HEIGHT', 2200);
const IGNORE_HTTPS_ERRORS = optionalBoolEnv('PSFN_UI_SWEEP_IGNORE_HTTPS_ERRORS', false);

const PAGES = [
  { name: 'dashboard', path: '/', expect: ['The Trunk', 'Dashboard overview'] },
  { name: 'tools', path: '/tools', expect: ['Direct runtime tool availability', 'Registered'] },
  { name: 'prompts', path: '/prompts', expect: ['Prompt Soil', 'Layered prompt composition stack'] },
  { name: 'memory', path: '/memory', expect: ['Memory Browser', 'Scoped Memory Tags'] },
  { name: 'sessions', path: '/sessions', expect: ['Session Browser', 'sessions'] },
  { name: 'settings', path: '/settings', expect: ['Runtime configuration and tuning', 'The Climate'] },
  { name: 'identity', path: '/identity', expect: ['Identity', 'Character identity and card data'] },
  { name: 'contacts', path: '/contacts', expect: ['Visitors', 'Contacts'] },
  { name: 'scheduler', path: '/scheduler', expect: ['Rhythms', 'Scheduler'] },
  { name: 'prompt-monitor', path: '/prompt-monitor', expect: ['Prompt Monitor'] },
  { name: 'skills', path: '/skills', expect: ['Skills'] },
  { name: 'values', path: '/values', expect: ['Values'] },
  { name: 'telemetry', path: '/telemetry', expect: ['Events'] },
  { name: 'models', path: '/models', expect: ['Models'] },
  { name: 'chat', path: '/chat', expect: ['Chat'] },
];

function loadPlaywright() {
  const packageJsonPath = join(BROWSER_PROBE_ROOT, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `Browser probe package missing at ${packageJsonPath}. `
      + 'Install playwright into PSFN_BROWSER_PROBE_ROOT first.',
    );
  }
  const requireFromProbe = createRequire(packageJsonPath);
  return requireFromProbe('playwright');
}

function normalizeBodyText(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

async function createBrowser(chromium) {
  try {
    return await chromium.launch({
      headless: true,
      channel: 'chrome',
    });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function analyzePage(context, pageDef) {
  const page = await context.newPage();
  const url = new URL(pageDef.path, ADMIN_BASE).toString();
  const screenshotPath = join(ARTIFACT_ROOT, `operator-ui-${pageDef.name}-playwright.png`);
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error instanceof Error ? error.message : String(error));
  });

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForTimeout(PAGE_SETTLE_MS);
    const title = await page.title();
    const bodyText = normalizeBodyText(await page.locator('body').innerText());
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });

    const missingExpectations = pageDef.expect.filter((needle) => !bodyText.includes(needle));
    const consoleWarnings = [...consoleErrors];
    const errorSignals = [
      ...pageErrors,
      ...['Application Error', 'Internal Error', 'Failed to load', 'Unhandled']
        .filter((needle) => bodyText.includes(needle)),
    ];

    return {
      name: pageDef.name,
      url,
      ok: missingExpectations.length === 0 && errorSignals.length === 0,
      title,
      screenshotPath,
      missingExpectations,
      consoleWarnings,
      errorSignals,
      bodyPreview: bodyText.slice(0, 1600),
    };
  } catch (error) {
    return {
      name: pageDef.name,
      url,
      ok: false,
      title: '',
      screenshotPath,
      missingExpectations: [...pageDef.expect],
      consoleWarnings: [...consoleErrors],
      errorSignals: [...pageErrors],
      error: error instanceof Error ? error.message : String(error),
      bodyPreview: '',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function authenticateContext(context) {
  const loginUrl = new URL('/', ADMIN_BASE).toString();
  const page = await context.newPage();

  try {
    await page.goto(loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForTimeout(PAGE_SETTLE_MS);

    const tokenField = page.getByLabel('Admin Token');
    if (await tokenField.count()) {
      await tokenField.fill(ADMIN_TOKEN);
      await page.getByRole('button', { name: /sign in|enter the garden/i }).click();
      await Promise.race([
        page.waitForURL((url) => !url.pathname.endsWith('/login'), {
          timeout: NAVIGATION_TIMEOUT_MS,
        }).catch(() => null),
        page.waitForFunction(
          () => !document.body.innerText.includes('Enter your admin token to continue'),
          { timeout: NAVIGATION_TIMEOUT_MS },
        ).catch(() => null),
      ]);
      await page.waitForTimeout(PAGE_SETTLE_MS);
    }

    const bodyText = normalizeBodyText(await page.locator('body').innerText());
    const dashboardReachable = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/admin/dashboard', {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        return res.ok;
      } catch {
        return false;
      }
    });
    return {
      ok: !bodyText.includes('Enter your admin token to continue') && dashboardReachable,
      reason: bodyText.includes('Enter your admin token to continue')
        ? 'Operator UI remained on the admin-token gate after attempted login.'
        : (!dashboardReachable ? 'Operator UI login completed, but /api/admin/dashboard still rejected the authenticated session.' : null),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  mkdirSync(ARTIFACT_ROOT, { recursive: true });
  const { chromium, devices } = loadPlaywright();
  const browser = await createBrowser(chromium);

  try {
    const context = await browser.newContext({
      ...devices['Desktop Chrome'],
      ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
      viewport: {
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
      },
    });
    const auth = await authenticateContext(context);

    if (auth.ok) {
      const preflightPage = await context.newPage();
      try {
        await preflightPage.goto(new URL('/', ADMIN_BASE).toString(), {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        await preflightPage.waitForTimeout(PAGE_SETTLE_MS);
        const preflightBody = normalizeBodyText(await preflightPage.locator('body').innerText());
        if (preflightBody.startsWith('Not found:')) {
          const output = {
            generatedAt: new Date().toISOString(),
            adminBase: ADMIN_BASE,
            browserProbeRoot: BROWSER_PROBE_ROOT,
            ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
            auth: {
              ok: false,
              reason: `Garden UI is not being served from ${ADMIN_BASE}. Received "${preflightBody}" after authentication; build the branch-local admin-ui and restart the operator surface.`,
            },
            pages: [],
            failures: PAGES.map((page) => page.name),
          };
          writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
          console.log(JSON.stringify({
            ok: false,
            outputPath: OUTPUT_PATH,
            pageCount: PAGES.length,
            failures: output.failures,
          }, null, 2));
          return;
        }
      } finally {
        await preflightPage.close().catch(() => {});
      }
    }

    const pages = [];
    for (const pageDef of PAGES) {
      pages.push(await analyzePage(context, pageDef));
    }

    const output = {
      generatedAt: new Date().toISOString(),
      adminBase: ADMIN_BASE,
      browserProbeRoot: BROWSER_PROBE_ROOT,
      ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
      auth,
      pages,
      failures: pages.filter((page) => !page.ok).map((page) => page.name),
    };
    writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({
      ok: output.failures.length === 0,
      outputPath: OUTPUT_PATH,
      pageCount: pages.length,
      failures: output.failures,
    }, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  failClosedOnEnv(error);
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

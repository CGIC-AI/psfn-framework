#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);

const REQUIRED_CONTINUITY_CHECKS = ['database', 'gatewayLink', 'schedulerHealthcheck'];
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_REPEAT_PAGE_AFTER_MS = 30 * 60_000;
const DEFAULT_STATE_FILE = fileURLToPath(
  new URL('../../data/ops/continuity-watchdog-state.json', import.meta.url),
);
const DEFAULT_NTFY_PRIORITY = 5;
const DEFAULT_NTFY_TITLE = 'Runtime watchdog page';

export function parsePositiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeInt(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = trimString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseCliFlags(argv) {
  const flags = new Set();
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '--check-config' || arg === '--json') {
      flags.add(arg);
    }
  }
  return flags;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value, limit = 500) {
  const text = trimString(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function sanitizeHeaderValue(value) {
  return trimString(value).replace(/[\r\n]+/g, ' ').slice(0, 240);
}

function resolveEndpoint(env) {
  const configured = trimString(env.CONTINUITY_WATCHDOG_ENDPOINT);
  if (configured.length > 0) return configured;
  const apiPort = parsePositiveInt(env.API_PORT, 3000);
  return `http://127.0.0.1:${apiPort}/health`;
}

function resolveStateFile(env) {
  const configured = trimString(env.CONTINUITY_WATCHDOG_STATE_FILE);
  return configured.length > 0 ? configured : DEFAULT_STATE_FILE;
}

function resolveWatchdogApiKey(env) {
  const configured = trimString(env.CONTINUITY_WATCHDOG_API_KEY);
  if (configured.length > 0) return configured;
  return trimString(env.API_KEY);
}

function resolveNtfyValue(env, watchdogName, gatewayName) {
  const watchdogValue = trimString(env[watchdogName]);
  if (watchdogValue.length > 0) return watchdogValue;
  return trimString(env[gatewayName]);
}

export function resolveWatchdogConfig(env = process.env, argv = process.argv.slice(2)) {
  const flags = parseCliFlags(argv);
  const dryRun = flags.has('--dry-run') || parseBoolean(env.CONTINUITY_WATCHDOG_DRY_RUN, false);
  const checkConfigOnly = flags.has('--check-config')
    || parseBoolean(env.CONTINUITY_WATCHDOG_CHECK_CONFIG_ONLY, false);
  const outputJson = flags.has('--json') || parseBoolean(env.CONTINUITY_WATCHDOG_JSON, false);

  return {
    endpoint: resolveEndpoint(env),
    timeoutMs: parsePositiveInt(env.CONTINUITY_WATCHDOG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxFailures: parsePositiveInt(env.CONTINUITY_WATCHDOG_MAX_FAILURES, DEFAULT_MAX_FAILURES),
    repeatPageAfterMs: parseNonNegativeInt(
      env.CONTINUITY_WATCHDOG_REPEAT_PAGE_AFTER_MS,
      DEFAULT_REPEAT_PAGE_AFTER_MS,
    ),
    stateFile: resolveStateFile(env),
    apiKey: resolveWatchdogApiKey(env),
    restartPid: parsePositiveInt(env.CONTINUITY_WATCHDOG_RESTART_PID, 0),
    serviceName: trimString(env.CONTINUITY_WATCHDOG_SYSTEMD_SERVICE),
    processPattern: trimString(env.CONTINUITY_WATCHDOG_PROCESS_PATTERN),
    systemctlBin: trimString(env.CONTINUITY_WATCHDOG_SYSTEMCTL_BIN) || 'systemctl',
    pgrepBin: trimString(env.CONTINUITY_WATCHDOG_PGREP_BIN) || 'pgrep',
    dryRun,
    checkConfigOnly,
    outputJson,
    ntfy: {
      baseUrl: resolveNtfyValue(env, 'CONTINUITY_WATCHDOG_NTFY_BASE_URL', 'NTFY_BASE_URL'),
      topic: resolveNtfyValue(env, 'CONTINUITY_WATCHDOG_NTFY_TOPIC', 'NTFY_TOPIC'),
      token: resolveNtfyValue(env, 'CONTINUITY_WATCHDOG_NTFY_TOKEN', 'NTFY_TOKEN'),
      tokenRequired: parseBoolean(env.CONTINUITY_WATCHDOG_NTFY_TOKEN_REQUIRED, true),
      title: trimString(env.CONTINUITY_WATCHDOG_NTFY_TITLE) || DEFAULT_NTFY_TITLE,
      priority: parsePositiveInt(env.CONTINUITY_WATCHDOG_NTFY_PRIORITY, DEFAULT_NTFY_PRIORITY),
      tags: trimString(env.CONTINUITY_WATCHDOG_NTFY_TAGS) || 'rotating_light,warning',
    },
  };
}

export function validatePagingConfig(config) {
  const errors = [];
  if (!config.ntfy.baseUrl) {
    errors.push('NTFY_BASE_URL or CONTINUITY_WATCHDOG_NTFY_BASE_URL is required');
  }
  if (!config.ntfy.topic) {
    errors.push('NTFY_TOPIC or CONTINUITY_WATCHDOG_NTFY_TOPIC is required');
  }
  if (config.ntfy.tokenRequired && !config.ntfy.token) {
    errors.push('NTFY_TOKEN or CONTINUITY_WATCHDOG_NTFY_TOKEN is required');
  }
  return errors;
}

export function toReasonFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Health endpoint returned a non-object payload';
  }

  const continuity = payload.continuity;
  if (!continuity || typeof continuity !== 'object') {
    return payload.status === 'healthy'
      ? 'Health payload missing continuity contract'
      : `Top-level health status is "${String(payload.status)}"`;
  }

  const checks = continuity.checks;
  if (!checks || typeof checks !== 'object') {
    return 'Continuity checks payload missing or invalid';
  }

  for (const key of REQUIRED_CONTINUITY_CHECKS) {
    const check = checks[key];
    if (!check || typeof check !== 'object') {
      return `Continuity check "${key}" missing`;
    }
    if (check.status !== 'healthy') {
      const detail = trimString(check.detail);
      return detail.length > 0
        ? `Continuity check "${key}" degraded: ${detail}`
        : `Continuity check "${key}" degraded`;
    }
  }

  if (continuity.status !== 'healthy') {
    return `Continuity status is "${String(continuity.status)}"`;
  }

  const subsystems = payload.subsystems;
  if (subsystems && typeof subsystems === 'object') {
    for (const [name, subsystem] of Object.entries(subsystems)) {
      if (!subsystem || typeof subsystem !== 'object') continue;
      if (subsystem.status !== 'healthy') {
        const detail = trimString(subsystem.detail);
        return detail.length > 0
          ? `Subsystem "${name}" degraded: ${detail}`
          : `Subsystem "${name}" degraded`;
      }
    }
  }

  if (payload.status !== 'healthy') {
    return `Top-level health status is "${String(payload.status)}"`;
  }

  return null;
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isHealthPayloadShape(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && ('status' in payload || 'continuity' in payload || 'subsystems' in payload),
  );
}

export async function fetchHealth(url, timeoutMs, apiKey, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers,
    });
    const payload = await readJsonResponse(response);
    const payloadReason = isHealthPayloadShape(payload) ? toReasonFromPayload(payload) : null;

    if (!response.ok) {
      return {
        ok: false,
        kind: payloadReason?.includes('schedulerHealthcheck') ? 'liveness_stale' : 'health_http',
        reason: payloadReason ?? `HTTP ${response.status}`,
        details: {
          httpStatus: response.status,
        },
      };
    }

    if (payloadReason) {
      return {
        ok: false,
        kind: payloadReason.includes('schedulerHealthcheck') ? 'liveness_stale' : 'health_contract',
        reason: payloadReason,
      };
    }

    return {
      ok: true,
      kind: 'health',
      reason: '',
    };
  } catch (error) {
    const message = error instanceof Error ? trimString(error.message) : '';
    return {
      ok: false,
      kind: 'health_unreachable',
      reason: message.length > 0 ? message : 'Health request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseSystemdShow(stdout) {
  const fields = {};
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return fields;
}

export async function checkSystemdUserService(config, execFileImpl = execFile) {
  if (!config.serviceName) {
    return {
      ok: true,
      kind: 'service',
      reason: '',
      skipped: true,
    };
  }

  try {
    const { stdout } = await execFileImpl(config.systemctlBin, [
      '--user',
      'show',
      config.serviceName,
      '--property=ActiveState',
      '--property=SubState',
      '--property=MainPID',
      '--property=Result',
      '--property=ExecMainStatus',
      '--no-pager',
    ], { timeout: config.timeoutMs });
    const fields = parseSystemdShow(stdout);
    const activeState = trimString(fields.ActiveState);
    const subState = trimString(fields.SubState);
    const mainPid = Number.parseInt(trimString(fields.MainPID), 10);

    if (activeState !== 'active') {
      return {
        ok: false,
        kind: 'service_down',
        reason: `systemd user service ${config.serviceName} is ${activeState || 'unknown'}${subState ? `/${subState}` : ''}`,
        details: fields,
      };
    }

    if (!Number.isFinite(mainPid) || mainPid <= 0) {
      return {
        ok: false,
        kind: 'process_down',
        reason: `systemd user service ${config.serviceName} has no live MainPID`,
        details: fields,
      };
    }

    return {
      ok: true,
      kind: 'service',
      reason: '',
      details: fields,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: 'service_check_failed',
      reason: `systemd user service check failed for ${config.serviceName}: ${message}`,
    };
  }
}

export async function checkProcessPattern(config, execFileImpl = execFile) {
  if (!config.processPattern) {
    return {
      ok: true,
      kind: 'process',
      reason: '',
      skipped: true,
    };
  }

  try {
    const { stdout } = await execFileImpl(config.pgrepBin, [
      '-f',
      config.processPattern,
    ], { timeout: config.timeoutMs });
    const pids = stdout
      .split(/\s+/)
      .map(value => Number.parseInt(value, 10))
      .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
    if (pids.length === 0) {
      return {
        ok: false,
        kind: 'process_down',
        reason: `No process matched CONTINUITY_WATCHDOG_PROCESS_PATTERN=${config.processPattern}`,
      };
    }
    return {
      ok: true,
      kind: 'process',
      reason: '',
      details: {
        matchedPids: pids,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: 'process_down',
      reason: `No process matched CONTINUITY_WATCHDOG_PROCESS_PATTERN=${config.processPattern}: ${message}`,
    };
  }
}

function emptyState() {
  return {
    consecutiveFailures: 0,
    pageHistory: {},
  };
}

export async function readWatchdogState(stateFile) {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const consecutiveFailures = Number.parseInt(String(parsed.consecutiveFailures ?? 0), 10);
    const pageHistory = parsed.pageHistory && typeof parsed.pageHistory === 'object'
      ? parsed.pageHistory
      : {};
    return {
      ...parsed,
      consecutiveFailures: Number.isFinite(consecutiveFailures) && consecutiveFailures >= 0
        ? consecutiveFailures
        : 0,
      pageHistory,
    };
  } catch {
    return emptyState();
  }
}

async function writeWatchdogState(stateFile, state) {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function pageHistoryEntries(pageHistory) {
  return Object.entries(pageHistory ?? {})
    .filter(([, value]) => value && typeof value === 'object');
}

function prunePageHistory(pageHistory, nowMs, repeatPageAfterMs) {
  const retentionMs = Math.max(repeatPageAfterMs * 4, 24 * 60 * 60_000);
  const pruned = {};
  for (const [fingerprint, entry] of pageHistoryEntries(pageHistory)) {
    const lastPagedAtMs = Date.parse(trimString(entry.lastPagedAt));
    if (!Number.isFinite(lastPagedAtMs) || nowMs - lastPagedAtMs <= retentionMs) {
      pruned[fingerprint] = entry;
    }
  }
  return pruned;
}

function buildIncident(failures, config) {
  const normalizedFailures = failures.map(failure => ({
    kind: failure.kind,
    reason: truncateText(failure.reason, 500),
  }));
  const fingerprint = JSON.stringify(normalizedFailures);
  const summary = normalizedFailures
    .map(failure => `${failure.kind}: ${failure.reason}`)
    .join(' | ');
  return {
    fingerprint,
    kind: normalizedFailures[0]?.kind ?? 'unknown',
    summary,
    failures: normalizedFailures,
    endpoint: config.endpoint,
    serviceName: config.serviceName,
    processPattern: config.processPattern,
  };
}

function shouldPageIncident(state, fingerprint, nowMs, repeatPageAfterMs) {
  const previous = state.pageHistory?.[fingerprint];
  if (!previous || typeof previous !== 'object') return true;
  if (repeatPageAfterMs <= 0) return false;
  const lastPagedAtMs = Date.parse(trimString(previous.lastPagedAt));
  if (!Number.isFinite(lastPagedAtMs)) return true;
  return nowMs - lastPagedAtMs >= repeatPageAfterMs;
}

function markPageSent(state, incident, nowIso) {
  const previousCount = Number.parseInt(String(state.pageHistory?.[incident.fingerprint]?.count ?? 0), 10);
  return {
    ...state,
    lastPagedAt: nowIso,
    pageHistory: {
      ...(state.pageHistory ?? {}),
      [incident.fingerprint]: {
        lastPagedAt: nowIso,
        count: (Number.isFinite(previousCount) ? previousCount : 0) + 1,
        kind: incident.kind,
        summary: incident.summary,
      },
    },
  };
}

async function recordFailureState(stateFile, state, incident, nowMs, maxFailures) {
  const nowIso = new Date(nowMs).toISOString();
  const nextFailures = state.consecutiveFailures + 1;
  const firstFailureAt = state.consecutiveFailures > 0
    ? state.firstFailureAt ?? nowIso
    : nowIso;
  const nextState = {
    ...state,
    consecutiveFailures: nextFailures,
    firstFailureAt,
    lastFailureAt: nowIso,
    lastReason: incident.summary,
    activeFingerprint: incident.fingerprint,
    failureThreshold: maxFailures,
  };
  await writeWatchdogState(stateFile, nextState);
  return nextState;
}

async function recordHealthyState(stateFile, previousState, nowMs) {
  const hadFailure = previousState.consecutiveFailures > 0 || previousState.activeFingerprint;
  if (!hadFailure && pageHistoryEntries(previousState.pageHistory).length === 0) {
    await rm(stateFile, { force: true });
    return emptyState();
  }
  const nextState = {
    consecutiveFailures: 0,
    lastRecoveryAt: new Date(nowMs).toISOString(),
    pageHistory: previousState.pageHistory ?? {},
  };
  await writeWatchdogState(stateFile, nextState);
  return nextState;
}

function buildNtfyMessage(incident, failures, consecutiveFailures, maxFailures) {
  const lines = [
    `Out-of-process watchdog detected runtime liveness failure (${consecutiveFailures}/${maxFailures}).`,
    `Reason: ${incident.summary}`,
    `Health endpoint: ${incident.endpoint}`,
  ];
  if (incident.serviceName) {
    lines.push(`systemd --user service: ${incident.serviceName}`);
  }
  if (incident.processPattern) {
    lines.push(`process pattern: ${incident.processPattern}`);
  }

  for (const failure of failures) {
    if (failure.details?.httpStatus) {
      lines.push(`${failure.kind} HTTP status: ${failure.details.httpStatus}`);
    }
  }

  return lines.join('\n');
}

export async function sendNtfyPage(config, incident, failures, consecutiveFailures, fetchImpl = fetch) {
  const endpoint = `${config.ntfy.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(config.ntfy.topic)}`;
  const message = buildNtfyMessage(incident, failures, consecutiveFailures, config.maxFailures);
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: sanitizeHeaderValue(config.ntfy.title),
    Priority: String(Math.max(1, Math.min(5, config.ntfy.priority))),
    Tags: sanitizeHeaderValue(config.ntfy.tags),
  };
  if (config.ntfy.token) {
    headers.Authorization = `Bearer ${config.ntfy.token}`;
  }

  if (config.dryRun) {
    return {
      status: 'dry-run',
      endpoint,
      message,
    };
  }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: message,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`ntfy request failed: ${response.status} ${response.statusText}`);
  }
  return {
    status: 'sent',
    endpoint,
    messageId: response.headers.get('x-message-id') ?? undefined,
  };
}

function maybeRestartTarget(config, logger) {
  const restartPid = config.restartPid;
  if (restartPid <= 0) return;
  if (restartPid === process.pid) return;

  try {
    process.kill(restartPid, 'SIGTERM');
    logger(`[continuity-watchdog] Sent SIGTERM to pid=${restartPid}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[continuity-watchdog] Failed to signal pid=${restartPid}: ${message}`);
  }
}

function logResult(result, logger, outputJson) {
  if (outputJson) {
    logger(JSON.stringify(result));
    return;
  }

  if (result.status === 'healthy') {
    logger('[continuity-watchdog] Health contract OK');
    return;
  }

  if (result.status === 'config_error') {
    logger(`[continuity-watchdog] Configuration error: ${result.errors.join('; ')}`);
    return;
  }

  if (result.status === 'unhealthy') {
    logger(
      `[continuity-watchdog] Health contract FAILED: ${result.reason} (${result.consecutiveFailures}/${result.maxFailures})`,
    );
    if (result.pageStatus === 'sent') {
      logger('[continuity-watchdog] ntfy page sent');
    } else if (result.pageStatus === 'dry-run') {
      logger('[continuity-watchdog] dry-run: ntfy page would be sent');
    } else if (result.pageStatus === 'debounced') {
      logger('[continuity-watchdog] ntfy page suppressed by replay guard');
    } else if (result.pageStatus === 'failed') {
      logger(`[continuity-watchdog] ntfy page failed: ${result.pageError}`);
    }
  }
}

export async function runWatchdogOnce(config, deps = {}) {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const logger = deps.logger ?? (() => {});
  // Paging config is only validated in --check-config mode and on the paging
  // path below: ordinary health probes must stay observable (e.g. as the
  // Docker healthcheck) even when ntfy env vars are absent.
  if (config.checkConfigOnly) {
    const validationErrors = validatePagingConfig(config);
    if (validationErrors.length > 0) {
      const result = {
        exitCode: 2,
        status: 'config_error',
        errors: validationErrors,
      };
      logResult(result, logger, config.outputJson);
      return result;
    }
    const result = {
      exitCode: 0,
      status: 'healthy',
      checks: [],
      reason: 'configuration OK',
    };
    logResult(result, logger, config.outputJson);
    return result;
  }

  const state = await readWatchdogState(config.stateFile);
  state.pageHistory = prunePageHistory(state.pageHistory, nowMs, config.repeatPageAfterMs);

  const serviceCheck = await checkSystemdUserService(config, deps.execFileImpl ?? execFile);
  const processCheck = await checkProcessPattern(config, deps.execFileImpl ?? execFile);
  const healthCheck = await fetchHealth(
    config.endpoint,
    config.timeoutMs,
    config.apiKey,
    deps.fetchImpl ?? fetch,
  );
  const checks = [serviceCheck, processCheck, healthCheck];
  const failures = checks.filter(check => !check.ok);

  if (failures.length === 0) {
    const nextState = await recordHealthyState(config.stateFile, state, nowMs);
    const result = {
      exitCode: 0,
      status: 'healthy',
      checks,
      state: nextState,
    };
    logResult(result, logger, config.outputJson);
    return result;
  }

  const incident = buildIncident(failures, config);
  const failedState = await recordFailureState(
    config.stateFile,
    state,
    incident,
    nowMs,
    config.maxFailures,
  );
  const consecutiveFailures = failedState.consecutiveFailures;
  let nextState = failedState;
  let pageStatus = 'below-threshold';
  let pageError = '';

  if (consecutiveFailures >= config.maxFailures) {
    if (shouldPageIncident(failedState, incident.fingerprint, nowMs, config.repeatPageAfterMs)) {
      const pagingConfigErrors = validatePagingConfig(config);
      if (pagingConfigErrors.length > 0) {
        // Fail closed on the paging path: the incident is still reported as
        // unhealthy and the unsendable page surfaces as a page failure.
        pageStatus = 'failed';
        pageError = `paging config invalid: ${pagingConfigErrors.join('; ')}`;
        nextState = {
          ...failedState,
          lastNtfyFailureAt: new Date(nowMs).toISOString(),
          lastNtfyFailure: pageError,
        };
        await writeWatchdogState(config.stateFile, nextState);
      } else {
        try {
          const pageResult = await sendNtfyPage(
            config,
            incident,
            failures,
            consecutiveFailures,
            deps.fetchImpl ?? fetch,
          );
          pageStatus = pageResult.status;
          if (pageResult.status === 'sent') {
            nextState = markPageSent(failedState, incident, new Date(nowMs).toISOString());
            await writeWatchdogState(config.stateFile, nextState);
          }
        } catch (error) {
          pageStatus = 'failed';
          pageError = error instanceof Error ? error.message : String(error);
          nextState = {
            ...failedState,
            lastNtfyFailureAt: new Date(nowMs).toISOString(),
            lastNtfyFailure: pageError,
          };
          await writeWatchdogState(config.stateFile, nextState);
        }
      }
    } else {
      pageStatus = 'debounced';
    }
    if (!config.dryRun) {
      maybeRestartTarget(config, logger);
    }
  }

  const result = {
    exitCode: pageStatus === 'failed' ? 2 : 1,
    status: 'unhealthy',
    reason: incident.summary,
    incident,
    checks,
    consecutiveFailures,
    maxFailures: config.maxFailures,
    pageStatus,
    ...(pageError ? { pageError } : {}),
    state: nextState,
  };
  logResult(result, logger, config.outputJson);
  return result;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

export async function main() {
  const config = resolveWatchdogConfig();
  const result = await runWatchdogOnce(config, {
    logger: message => {
      console.error(message);
    },
  });
  process.exit(result.exitCode);
}

if (isMainModule()) {
  await main();
}

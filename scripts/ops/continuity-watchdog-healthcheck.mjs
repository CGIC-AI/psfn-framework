#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const REQUIRED_CONTINUITY_CHECKS = ['database', 'gatewayLink', 'schedulerHeartbeat'];
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_STATE_FILE = '/tmp/psfn-continuity-watchdog-state.json';

function parsePositiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveEndpoint() {
  const configured = trimString(process.env.CONTINUITY_WATCHDOG_ENDPOINT);
  if (configured.length > 0) return configured;
  const apiPort = parsePositiveInt(process.env.API_PORT, 3000);
  return `http://127.0.0.1:${apiPort}/health`;
}

function resolveStateFile() {
  const configured = trimString(process.env.CONTINUITY_WATCHDOG_STATE_FILE);
  return configured.length > 0 ? configured : DEFAULT_STATE_FILE;
}

function resolveWatchdogApiKey() {
  const configured = trimString(process.env.CONTINUITY_WATCHDOG_API_KEY);
  if (configured.length > 0) return configured;
  return trimString(process.env.API_KEY);
}

function toReasonFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Health endpoint returned a non-object payload';
  }
  if (payload.status !== 'healthy') {
    return `Top-level health status is "${String(payload.status)}"`;
  }

  if (!payload.continuity || typeof payload.continuity !== 'object') {
    return 'Health payload missing continuity contract';
  }
  if (payload.continuity.status !== 'healthy') {
    return `Continuity status is "${String(payload.continuity.status)}"`;
  }

  const checks = payload.continuity.checks;
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

  return null;
}

async function fetchHealth(url, timeoutMs, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP ${response.status}`,
      };
    }

    const reason = toReasonFromPayload(payload);
    if (reason) {
      return {
        ok: false,
        reason,
      };
    }

    return {
      ok: true,
      reason: '',
    };
  } catch (error) {
    const message = error instanceof Error ? trimString(error.message) : '';
    return {
      ok: false,
      reason: message.length > 0 ? message : 'Health request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readFailureCount(stateFile) {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return 0;
    const value = Number.parseInt(String(parsed.consecutiveFailures ?? 0), 10);
    if (!Number.isFinite(value) || value < 0) return 0;
    return value;
  } catch {
    return 0;
  }
}

async function writeFailureCount(stateFile, consecutiveFailures, reason) {
  await mkdir(dirname(stateFile), { recursive: true });
  const payload = {
    consecutiveFailures,
    lastFailureAt: new Date().toISOString(),
    reason,
  };
  await writeFile(stateFile, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function clearFailureState(stateFile) {
  try {
    await rm(stateFile, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

function maybeRestartTarget() {
  const restartPid = parsePositiveInt(process.env.CONTINUITY_WATCHDOG_RESTART_PID, 0);
  if (restartPid <= 0) return;
  if (restartPid === process.pid) return;

  try {
    process.kill(restartPid, 'SIGTERM');
    console.error(`[continuity-watchdog] Sent SIGTERM to pid=${restartPid}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[continuity-watchdog] Failed to signal pid=${restartPid}: ${message}`);
  }
}

async function main() {
  const endpoint = resolveEndpoint();
  const timeoutMs = parsePositiveInt(process.env.CONTINUITY_WATCHDOG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxFailures = parsePositiveInt(process.env.CONTINUITY_WATCHDOG_MAX_FAILURES, DEFAULT_MAX_FAILURES);
  const stateFile = resolveStateFile();
  const apiKey = resolveWatchdogApiKey();

  const result = await fetchHealth(endpoint, timeoutMs, apiKey);
  if (result.ok) {
    await clearFailureState(stateFile);
    console.error('[continuity-watchdog] Health contract OK');
    process.exit(0);
    return;
  }

  const priorFailures = await readFailureCount(stateFile);
  const failures = priorFailures + 1;
  await writeFailureCount(stateFile, failures, result.reason);
  console.error(
    `[continuity-watchdog] Health contract FAILED: ${result.reason} (${failures}/${maxFailures})`,
  );

  if (failures >= maxFailures) {
    console.error('[continuity-watchdog] Failure threshold reached');
    maybeRestartTarget();
  }

  process.exit(1);
}

await main();

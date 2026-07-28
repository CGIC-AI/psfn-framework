// ── Optional provider connectivity check (psfn-framework-wckv.1.2) ──
// A single cheap authenticated call that surfaces a bad key at onboarding time
// instead of at first chat. Always optional and clearly skippable for offline
// setups. The key is passed in memory and never logged.

import type { ProviderSelection } from './types.js';

export interface ConnectivityResult {
  ok: boolean;
  /** Actionable, secret-free message describing the outcome. */
  message: string;
}

/**
 * Probe the provider with one lightweight authenticated request. For
 * OpenAI-compatible providers this is a GET on the models list; for anthropic a
 * minimal models call. Network/HTTP failures return an actionable message rather
 * than throwing, so the flow can continue.
 */
export async function checkProviderConnectivity(
  provider: ProviderSelection,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ConnectivityResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const doFetch = options.fetchImpl ?? fetch;
  const { url, headers } = buildProbe(provider);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: `Provider rejected the key (HTTP ${response.status}). Check ${provider.apiKeyEnvName} `
          + `and that the account has access to ${provider.label}.`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        message: `Provider probe to ${redactUrl(url)} returned HTTP ${response.status}. `
          + 'The endpoint is reachable but did not accept the request; verify the base URL and key.',
      };
    }
    return { ok: true, message: `Reached ${provider.label} and the key was accepted.` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      message: aborted
        ? `Provider probe timed out after ${timeoutMs}ms reaching ${redactUrl(url)}. `
          + 'Check network egress and the base URL, or skip this step for offline setup.'
        : `Could not reach ${redactUrl(url)}: ${reason}. `
          + 'Check the base URL and network egress, or skip this step for offline setup.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildProbe(provider: ProviderSelection): { url: string; headers: Record<string, string> } {
  const base = provider.apiBaseUrl.replace(/\/+$/u, '');
  if (provider.type === 'anthropic') {
    return {
      url: `${base}/models`,
      headers: { 'x-api-key': provider.apiKeyValue, 'anthropic-version': '2023-06-01' },
    };
  }
  // openrouter, openai, google (openai-compat), mistral, litellm_proxy,
  // generic_openai all expose an OpenAI-style /models list.
  const url = provider.modelsApiUrl ?? `${base}/models`;
  return { url, headers: { Authorization: `Bearer ${provider.apiKeyValue}` } };
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

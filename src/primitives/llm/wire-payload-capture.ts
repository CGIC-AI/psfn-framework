import { isRecord } from '../../shared/utils/types.js';
import type { LLMCapturedProviderWirePayload } from '../../shared/contracts/runtime.js';
import { normalizeJsonValueForSerialization } from '../../shared/utils/json-serialization.js';

/**
 * Capture the true provider wire body as-sent (bead hgw3-80f6).
 *
 * pi-ai exposes the outbound provider request body through `StreamOptions.onPayload`
 * (`node_modules/@earendil-works/pi-ai/dist/types.d.ts`). The body is the JSON that
 * actually goes over the network — it already carries the tool schemas (each once),
 * `cache_control` breakpoints, and provider-specific transforms that the pre-call
 * `providerWireMessages` reconstructions omit. This module turns that raw payload
 * into the persisted `LLMCapturedProviderWirePayload` summary.
 */

/**
 * Deep-clone the payload the way it will actually be serialized over the wire:
 * a JSON round-trip mirrors the exact bytes the transport sends (dropping
 * `undefined`/functions identically to JSON.stringify on the HTTP body). Throws
 * on non-serializable input so callers fail loudly rather than persist a lie.
 */
export function cloneWireBody(payload: unknown): unknown {
  return normalizeJsonValueForSerialization(payload, 'provider wire payload');
}

/**
 * Count the tool definitions in a provider request body. Anthropic-messages and
 * OpenAI-compatible bodies both carry a top-level `tools` array with one entry
 * per active tool, so the count is the length of that array (each tool serialized
 * exactly once — the invariant the bead's `input_schema count == active-tool
 * count` acceptance check asserts). Bodies without a tools array report 0.
 */
export function countWireToolDefinitions(body: unknown): number {
  if (!isRecord(body)) return 0;
  const tools = body.tools;
  return Array.isArray(tools) ? tools.length : 0;
}

/**
 * Build the captured-wire summary from an outbound provider payload. The returned
 * object carries the full `body` (used by the live Loom view and content-addressed
 * into the sidecar at persist time) plus the small always-inline summary fields.
 */
export function captureProviderWirePayload(
  payload: unknown,
  model: { id: unknown; api?: unknown },
): LLMCapturedProviderWirePayload {
  const body = cloneWireBody(payload);
  const serialized = JSON.stringify(body);
  return {
    api: typeof model.api === 'string' && model.api.length > 0 ? model.api : 'unknown',
    model: String(model.id),
    capturedAtMs: Date.now(),
    byteLength: typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : 0,
    toolCount: countWireToolDefinitions(body),
    body,
  };
}

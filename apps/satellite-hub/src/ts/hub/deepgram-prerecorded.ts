import { discardUpstream, fetchUpstream, readUpstreamJson } from "../shared/upstream-response.js";
import type { TranscriptResult } from "./deepgram-live.js";
import { resolveHubResourceLimits, type HubResourceLimits } from "./transport-resources.js";

export async function transcribePcmClip(
  apiKey: string,
  pcm: Buffer,
  signal?: AbortSignal,
  overrides?: Partial<HubResourceLimits>,
  endpoint = "https://api.deepgram.com/v1/listen",
): Promise<TranscriptResult> {
  const limits = resolveHubResourceLimits(overrides);
  const startedAt = Date.now();
  const response = await fetchUpstream(`${endpoint}?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&smart_format=true`, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/raw" },
    body: new Uint8Array(pcm),
    signal,
  }, limits.providerTimeoutMs);
  if (!response.ok) {
    await discardUpstream(response);
    throw new Error(`Deepgram transcription failed (${response.status})`);
  }
  const payload = await readUpstreamJson(response, {
    maxBytes: limits.maxHttpBodyBytes, timeoutMs: limits.providerTimeoutMs, signal,
  }) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
  const transcript = payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (transcript !== undefined && typeof transcript !== "string") throw new Error("Deepgram transcription response is invalid");
  return { text: transcript?.trim() || "", provider: "deepgram-prerecorded", latencyMs: Date.now() - startedAt };
}

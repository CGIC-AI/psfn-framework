import { DEFAULT_HUB_LIMITS } from "../hub/transport-resources.js";
import { discardUpstream, fetchUpstream, readUpstreamBytes, UpstreamResponseError } from "../shared/upstream-response.js";

interface GeneratedImageDownload {
  packReady: boolean;
  packIssue?: string;
  dataUrl?: string;
}

/** The Studio server supplies its existing pack-review byte ceiling. */
export async function downloadGeneratedImage(imageUrl: string, maxBytes: number, options: {
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<GeneratedImageDownload> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HUB_LIMITS.providerTimeoutMs;
  try {
    const response = await fetchUpstream(imageUrl, { signal: options.signal }, timeoutMs);
    if (!response.ok) {
      await discardUpstream(response);
      return { packReady: false, packIssue: `Generated image download failed (${response.status})` };
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "image/png") {
      await discardUpstream(response);
      return { packReady: false, packIssue: "Generated image must be a PNG before packing" };
    }
    const bytes = await readUpstreamBytes(response, { maxBytes, timeoutMs, signal: options.signal });
    return { packReady: true, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  } catch (error) {
    return { packReady: false, packIssue: error instanceof UpstreamResponseError && error.code === "size"
      ? "Generated image exceeds Device Studio pack review size limit" : "Generated image download failed" };
  }
}

/** Sequential reads share one aggregate budget instead of fan-out buffering. */
export async function downloadGeneratedImages<T extends { url: string }>(images: readonly T[], maxBytes: number): Promise<Array<T & Partial<GeneratedImageDownload>>> {
  let remaining = maxBytes;
  const output: Array<T & Partial<GeneratedImageDownload>> = [];
  for (const image of images) {
    const download = remaining > 0 ? await downloadGeneratedImage(image.url, remaining)
      : { packReady: false, packIssue: "Generated images exceed Device Studio pack review size limit" };
    if (download.dataUrl) remaining -= Buffer.byteLength(download.dataUrl.slice("data:image/png;base64,".length), "base64");
    output.push({ ...image, ...download });
  }
  return output;
}

/** Bound SDK upload-control replies before its response handlers buffer them. */
export const boundedFalFetch: typeof fetch = async (input, init) => {
  const response = await fetchUpstream(input, init ?? {}, DEFAULT_HUB_LIMITS.providerTimeoutMs);
  if (!response.ok) {
    await discardUpstream(response);
    throw new Error(`FAL storage request failed (${response.status})`);
  }
  const bytes = await readUpstreamBytes(response, {
    maxBytes: DEFAULT_HUB_LIMITS.maxHttpBodyBytes, timeoutMs: DEFAULT_HUB_LIMITS.providerTimeoutMs, signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
  });
  return new Response(bytes.length ? new Uint8Array(bytes) : null, { status: response.status, headers: response.headers });
};

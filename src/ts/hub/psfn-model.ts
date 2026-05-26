import fs from "node:fs";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import type { ConversationMessage } from "./session-store.js";
import type { PsfnChannelContext } from "./embodied-session.js";
import type { AgentRuntimeAdapter } from "./agent-runtime.js";
import type { PsfnRuntimeConfig } from "../shared/env.js";
import type { RuntimeIdentity } from "../shared/protocol.js";
import {
  buildSatelliteClaimEnvelope,
  buildSatelliteRegistryHeaders,
  defaultCapabilitiesForProfile,
  type SatelliteClaimEnvelope,
} from "./satellite-claim.js";

interface CompletionResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  chunks(): AsyncIterable<Uint8Array>;
}

type PsfnChatMessageContent =
  | string
  | Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string; name?: string }
  >;

type PsfnChatMessage = {
  role: "user" | "assistant";
  content: PsfnChatMessageContent;
};

const DEFAULT_SYSTEM_PROMPT =
  "Reply as plain spoken dialogue only, in one short sentence unless the user explicitly asks for more. "
  + "Do not use roleplay actions, stage directions, emotes, asterisks, markdown, narration, or scene-setting. "
  + "Do not call tools. Do not add preambles, summaries, or extra reassurance.";
const DEFAULT_PSFN_AGENT_BUSY_MAX_RETRIES = 12;

export class PsfnModelAdapter implements AgentRuntimeAdapter {
  private readonly apiBaseUrl: string;
  private identityRequest: Promise<RuntimeIdentity | null> | null = null;

  constructor(private readonly runtime: PsfnRuntimeConfig) {
    const baseUrl = runtime.baseUrl.replace(/\/$/, "");
    this.apiBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  }

  async *streamReply(input: {
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
    channel?: PsfnChannelContext;
  }): AsyncGenerator<string, string, void> {
    const conversationId = input.conversationId?.trim();
    if (!conversationId) {
      throw new Error("PSFN conversation ID is required for the satellite claim registry bridge");
    }
    const channel = input.channel ?? buildDefaultChannelContext(this.runtime.satelliteClaim, conversationId);
    const satelliteClaim = buildSatelliteClaimEnvelope({
      config: this.runtime.satelliteClaim,
      conversationId,
      channel,
      apiKey: this.runtime.apiKey,
    });
    const channelMetadata = buildChannelMetadata(channel, satelliteClaim);
    const response = await this.postChatCompletionWithBusyRetry(
      this.buildHeaders(channel, satelliteClaim, channelMetadata),
      JSON.stringify({
        model: this.runtime.model,
        stream: false,
        max_tokens: 80,
        system_prompt_mode: "custom",
        system_prompt: DEFAULT_SYSTEM_PROMPT,
        response_style: "concise",
        user: conversationId,
        satellite_claim: satelliteClaim,
        channel_metadata: channelMetadata,
        messages: this.buildMessages(input.history ?? [], input.userText, channel),
      }),
    );

    if (!response.ok) {
      throw new Error(await formatError(response));
    }

    const fullText = extractCompletionText(await response.text()).trim();
    if (!fullText) {
      throw new Error("PSFN chat completion response did not include assistant content");
    }
    yield fullText;
    return fullText.trim();
  }

  async close(): Promise<void> {}

  async getIdentity(): Promise<RuntimeIdentity | null> {
    this.identityRequest ??= this.fetchIdentity();
    return this.identityRequest;
  }

  private async fetchIdentity(): Promise<RuntimeIdentity | null> {
    const response = await fetch(`${this.apiBaseUrl}/identity`, {
      method: "GET",
      headers: this.buildIdentityHeaders(),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      console.warn(`PSFN identity endpoint failed (${response.status})`);
      return null;
    }
    const payload = await response.json().catch(() => null);
    return extractRuntimeIdentity(payload);
  }

  private buildIdentityHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.runtime.apiKey) {
      headers.Authorization = `Bearer ${this.runtime.apiKey}`;
    }
    return headers;
  }

  private async postChatCompletion(headers: Record<string, string>, body: string): Promise<CompletionResponse> {
    const url = `${this.apiBaseUrl}/chat/completions`;
    const tls = this.runtime.satelliteClaim.tls;
    if (tls?.certPath && tls.keyPath) {
      return this.postChatCompletionWithClientCertificate(url, headers, body, tls);
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
    });
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      chunks: async function* chunks() {
        if (!response.body) {
          throw new Error("PSFN chat completion response did not include a body");
        }
        const reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          yield value;
        }
      },
    };
  }

  private async postChatCompletionWithBusyRetry(
    headers: Record<string, string>,
    body: string,
  ): Promise<CompletionResponse> {
    const maxRetries = agentBusyMaxRetries();
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await this.postChatCompletion(headers, body);
      if (response.ok) {
        return response;
      }
      const responseText = await response.text();
      if (!isAgentBusyResponse(response.status, responseText) || attempt >= maxRetries) {
        return responseFromText(response.status, responseText);
      }
      await delay(agentBusyRetryDelayMs(attempt));
    }
    return responseFromText(503, '{"error":{"message":"Agent is already processing another prompt"}}');
  }

  private async postChatCompletionWithClientCertificate(
    rawUrl: string,
    headers: Record<string, string>,
    body: string,
    tls: NonNullable<PsfnRuntimeConfig["satelliteClaim"]["tls"]>,
  ): Promise<CompletionResponse> {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") {
      throw new Error("PSFN_CLIENT_CERT_PATH requires an https PSFN_API_BASE_URL");
    }
    return await new Promise<CompletionResponse>((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": Buffer.byteLength(body).toString(),
          },
          cert: fs.readFileSync(requiredPath(tls.certPath, "PSFN_CLIENT_CERT_PATH")),
          key: fs.readFileSync(requiredPath(tls.keyPath, "PSFN_CLIENT_KEY_PATH")),
          ...(tls.caPath ? { ca: fs.readFileSync(tls.caPath) } : {}),
        },
        (message) => {
          resolve(responseFromIncomingMessage(message));
        },
      );
      request.on("error", reject);
      request.write(body);
      request.end();
    });
  }

  private buildHeaders(
    channel: PsfnChannelContext,
    satelliteClaim: SatelliteClaimEnvelope,
    channelMetadata: Record<string, unknown>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.runtime.apiKey) {
      headers.Authorization = `Bearer ${this.runtime.apiKey}`;
    }
    headers["X-PSFN-Channel-Type"] = channel.channelType;
    headers["X-PSFN-Channel-ID"] = channel.channelId;
    headers["X-PSFN-Satellite-ID"] = channel.sourceSatelliteId;
    headers["X-PSFN-Satellite-Name"] = channel.sourceSatelliteName;
    Object.assign(headers, buildSatelliteRegistryHeaders({
      config: this.runtime.satelliteClaim,
      satelliteClaim,
    }));
    headers["X-PSFN-Satellite-Claim"] = JSON.stringify(sanitizeHeaderJsonValue(satelliteClaim));
    headers["X-PSFN-Channel-Metadata"] = JSON.stringify(sanitizeHeaderJsonValue(channelMetadata));
    return sanitizeHttpHeaders(headers);
  }

  private buildMessages(
    history: ConversationMessage[],
    userText: string,
    channel: PsfnChannelContext,
  ): PsfnChatMessage[] {
    const contextualUserText = buildContextualUserText(userText, channel);
    const messages: PsfnChatMessage[] = history
      .filter((message) => message.content.trim().length > 0)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));
    const currentVisionImages = normalizeVisionCaptureImages(channel);
    if (currentVisionImages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "user" && lastMessage.content === userText) {
        messages.pop();
      }
      messages.push({
        role: "user",
        content: buildInlineVisionContent(contextualUserText, currentVisionImages),
      });
    } else {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "user" && lastMessage.content === userText) {
        messages.pop();
      }
      if (!messages.length || messages[messages.length - 1]?.content !== contextualUserText) {
        messages.push({ role: "user", content: contextualUserText });
      }
    }
    return messages;
  }
}

function buildDefaultChannelContext(config: PsfnRuntimeConfig["satelliteClaim"], conversationId: string): PsfnChannelContext {
  const channelId = deriveChannelId(config.channelType, conversationId);
  const capabilities = defaultCapabilitiesForProfile(config.capabilityProfile);
  return {
    sessionId: conversationId,
    channelType: config.channelType,
    channelId,
    sourceSatelliteId: config.satelliteId,
    sourceSatelliteName: config.displayName,
    activeSatellites: [
      {
        id: config.satelliteId,
        name: config.displayName,
        transport: "websocket",
        capabilities,
      },
    ],
  };
}

function buildChannelMetadata(
  channel: PsfnChannelContext,
  satelliteClaim: SatelliteClaimEnvelope,
): Record<string, unknown> {
  return {
    sessionId: channel.sessionId,
    sourceSatelliteId: channel.sourceSatelliteId,
    sourceSatelliteName: channel.sourceSatelliteName,
    activeSatellites: channel.activeSatellites,
    ...(channel.visionCaptures?.length ? { visionCaptures: channel.visionCaptures } : {}),
    ...(channel.contextNotes?.length ? { contextNotes: normalizeContextNotes(channel.contextNotes) } : {}),
    satelliteClaim,
  };
}

function sanitizeHttpHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, sanitizeHttpHeaderValue(value)]),
  );
}

function sanitizeHeaderJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeHttpHeaderValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeHeaderJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeHeaderJsonValue(item)]),
    );
  }
  return value;
}

function sanitizeHttpHeaderValue(value: string): string {
  let output = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0x2013 || codePoint === 0x2014) {
      output += "-";
    } else if (codePoint === 0x2018 || codePoint === 0x2019) {
      output += "'";
    } else if (codePoint === 0x201c || codePoint === 0x201d) {
      output += "'";
    } else if (codePoint === 0x2026) {
      output += "...";
    } else if (codePoint === 0x00a0) {
      output += " ";
    } else if (codePoint === 0x09 || (codePoint >= 0x20 && codePoint <= 0xff && codePoint !== 0x7f)) {
      output += char;
    } else {
      output += "?";
    }
  }
  return output.replace(/[\r\n]+/g, " ");
}

function buildContextualUserText(userText: string, channel: PsfnChannelContext): string {
  const contextNotes = normalizeContextNotes(channel.contextNotes ?? []);
  if (contextNotes.length === 0) {
    return userText;
  }
  const lines = [
    "Current VaM context:",
    ...contextNotes.map((note) => `- [${note.key}] ${note.text}`),
    "",
    "User turn:",
    userText.trim(),
  ];
  return lines.join("\n");
}

function normalizeContextNotes(notes: NonNullable<PsfnChannelContext["contextNotes"]>): Array<{ key: string; text: string }> {
  return notes
    .map((note) => ({
      key: note.key.trim(),
      text: note.text.trim(),
    }))
    .filter((note) => note.key.length > 0 && note.text.length > 0)
    .slice(-12);
}

function normalizeVisionCaptureImages(
  channel: PsfnChannelContext,
): NonNullable<PsfnChannelContext["visionCaptureImages"]> {
  return (channel.visionCaptureImages ?? [])
    .filter((capture) => capture.dataBase64.trim().length > 0 && capture.mimeType.startsWith("image/"))
    .slice(-4);
}

function buildInlineVisionContent(
  userText: string,
  captures: NonNullable<PsfnChannelContext["visionCaptureImages"]>,
): PsfnChatMessageContent {
  const content: Exclude<PsfnChatMessageContent, string> = [];
  const text = userText.trim();
  if (text) {
    content.push({ type: "text", text });
  }
  for (const capture of captures) {
    content.push({
      type: "image",
      data: capture.dataBase64,
      mimeType: capture.mimeType,
      name: `${capture.label}-${capture.source.toLowerCase()}.jpg`,
    });
  }
  return content;
}

function deriveChannelId(channelType: string, conversationId: string): string {
  const normalized = conversationId.trim();
  if (!normalized) {
    throw new Error("PSFN conversation ID is required for channel derivation");
  }
  if (normalized.startsWith(`${channelType}:`)) {
    return normalized;
  }
  return `${channelType}:${normalized}`;
}

function extractCompletionText(payload: string): string {
  const parsed = JSON.parse(payload) as {
    choices?: Array<{
      delta?: { content?: string; role?: string };
      message?: { content?: string };
      text?: string;
    }>;
  };
  const firstChoice = parsed.choices?.[0];
  if (!firstChoice) return "";
  if (typeof firstChoice.delta?.content === "string") return firstChoice.delta.content;
  if (typeof firstChoice.message?.content === "string") return firstChoice.message.content;
  if (typeof firstChoice.text === "string") return firstChoice.text;
  return "";
}

function extractRuntimeIdentity(payload: unknown): RuntimeIdentity | null {
  if (!isRecord(payload)) return null;

  const companion = isRecord(payload.companion) ? payload.companion : undefined;
  const channels = isRecord(payload.channels) ? payload.channels : undefined;
  const psfnAmica = channels && isRecord(channels["psfn-amica"])
    ? channels["psfn-amica"]
    : undefined;
  const user = psfnAmica && isRecord(psfnAmica.user)
    ? psfnAmica.user
    : undefined;

  const companionName = readString(companion?.name);
  const companionId = readString(companion?.id);
  const userName = readString(user?.name);
  const userId = readString(user?.id);
  const canonicalContactId = readString(psfnAmica?.canonicalContactId);

  const identity: RuntimeIdentity = {
    source: "framework",
    ...(companionName || companionId
      ? {
        companion: {
          ...(companionId ? { id: companionId } : {}),
          ...(companionName ? { name: companionName } : {}),
        },
      }
      : {}),
    ...(userName || userId || canonicalContactId
      ? {
        user: {
          ...(userId ? { id: userId } : {}),
          ...(userName ? { name: userName } : {}),
          ...(canonicalContactId ? { canonicalContactId } : {}),
        },
      }
      : {}),
  };

  return identity.companion || identity.user ? identity : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function formatError(response: CompletionResponse): Promise<string> {
  const body = (await response.text()).trim();
  if (body) {
    return `PSFN chat completion failed (${response.status}): ${body}`;
  }
  return `PSFN chat completion failed (${response.status})`;
}

function isAgentBusyResponse(status: number, body: string): boolean {
  return status === 503 && (
    body.includes('"type":"agent_busy"') ||
    body.includes('"type": "agent_busy"') ||
    body.toLowerCase().includes("agent is already processing another prompt")
  );
}

function agentBusyRetryDelayMs(attempt: number): number {
  const base = Number.parseInt(process.env.PSFN_AGENT_BUSY_RETRY_BASE_MS || "750", 10);
  const normalizedBase = Number.isFinite(base) && base >= 0 ? base : 750;
  return Math.min(5_000, normalizedBase * (attempt + 1));
}

function agentBusyMaxRetries(): number {
  const configured = Number.parseInt(process.env.PSFN_AGENT_BUSY_MAX_RETRIES || "", 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_PSFN_AGENT_BUSY_MAX_RETRIES;
}

function responseFromText(status: number, body: string): CompletionResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    chunks: async function* chunks() {
      yield Buffer.from(body, "utf8");
    },
  };
}

function responseFromIncomingMessage(message: IncomingMessage): CompletionResponse {
  return {
    ok: Boolean(message.statusCode && message.statusCode >= 200 && message.statusCode < 300),
    status: message.statusCode ?? 0,
    text: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of message) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    chunks: async function* chunks() {
      for await (const chunk of message) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    },
  };
}

function requiredPath(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required when PSFN client certificate auth is configured`);
  }
  return value;
}

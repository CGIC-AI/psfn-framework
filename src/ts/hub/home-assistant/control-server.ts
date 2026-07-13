import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { HubControlConfig } from "../../shared/env.js";
import { authenticateHubDevice, type HubDeviceIdentity, type HubDeviceRegistry } from "../device-registry.js";
import { HomeAssistantClient } from "./client.js";
import {
  HOME_ASSISTANT_ALLOWED_DOMAINS,
  HOME_ASSISTANT_ALLOWED_SERVICES,
  HomeAssistantRequestError,
  HomeAssistantUnavailableError,
  type HomeAssistantAllowedDomain,
  type HomeAssistantAllowedService,
  type HomeAssistantCallServiceInput,
  type HomeAssistantCallServiceResult,
} from "./contracts.js";

const ENTITY_ID_PATTERN = /^[a-z][a-z0-9_]*\.[A-Za-z0-9_]+$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ENTITY_IDS = 50;
const MAX_IDEMPOTENCY_ENTRIES = 1_024;
const ALLOWED_SERVICE_DATA_KEYS = new Set([
  "brightness",
  "brightness_pct",
  "color_temp_kelvin",
  "rgb_color",
  "transition",
  "volume_level",
  "percentage",
]);

interface IdempotencyEntry {
  bodyHash: string;
  result: HomeAssistantCallServiceResult;
}

interface HomeAssistantPrincipal {
  id: string;
  entityIds: readonly string[];
}

export class HomeAssistantControlServer {
  private readonly server: http.Server;
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly config: HubControlConfig,
    private readonly client: HomeAssistantClient,
    private readonly deviceRegistry: HubDeviceRegistry,
  ) {
    if (authenticateHubDevice(deviceRegistry, config.token)) {
      throw new Error("HUB_CONTROL_TOKEN must not match a registered device credential");
    }
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.writeError(response, error);
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.bindHost, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  address(): AddressInfo | string | null {
    return this.server.address();
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const url = new URL(request.url ?? "/", "http://hub-control.invalid");
    const isHealthRequest = request.method === "GET" && url.pathname === "/internal/v1/home-assistant/health";
    const principal = isHealthRequest ? null : this.authenticatePrincipal(request.headers.authorization);
    if (isHealthRequest ? !this.authorizedControlToken(request.headers.authorization) : !principal) {
      response.statusCode = 401;
      response.setHeader("WWW-Authenticate", "Bearer");
      response.end(JSON.stringify({ error: { type: "unauthorized", message: "Invalid Hub control credential" } }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/internal/v1/home-assistant/health") {
      response.statusCode = 200;
      response.end(JSON.stringify(this.client.health()));
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/home-assistant/states") {
      const body = await this.readJsonBody(request);
      const entityIds = body.entityIds === undefined ? [] : parseEntityIds(body.entityIds, true);
      const authorizedIds = entityIds.length === 0 ? principal!.entityIds : entityIds;
      this.assertEntitiesAllowed(principal!, authorizedIds);
      response.statusCode = 200;
      const states = this.client.getStates(authorizedIds);
      response.end(JSON.stringify({ states, count: states.length }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/home-assistant/call-service") {
      const body = await this.readJsonBody(request);
      const input = parseCallService(body);
      this.assertEntitiesAllowed(principal!, input.entityIds);
      const bodyHash = hashCanonical(input);
      const prior = this.idempotency.get(input.requestId);
      if (prior) {
        if (prior.bodyHash !== bodyHash) {
          response.statusCode = 409;
          response.end(JSON.stringify({
            error: { type: "idempotency_conflict", message: "requestId was already used with a different payload" },
          }));
          return;
        }
        response.statusCode = 200;
        response.end(JSON.stringify({ ...prior.result, replayed: true }));
        return;
      }
      const result = await this.client.callService(input);
      this.remember(input.requestId, { bodyHash, result });
      response.statusCode = 200;
      response.end(JSON.stringify({ ...result, replayed: false }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: { type: "not_found", message: "Unknown Hub control route" } }));
  }

  private authorizedControlToken(raw: string | undefined): boolean {
    if (!raw?.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(raw.slice("Bearer ".length), "utf8");
    const expected = Buffer.from(this.config.token, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private authenticateDevice(raw: string | undefined): HubDeviceIdentity | null {
    if (!raw?.startsWith("Bearer ")) return null;
    return authenticateHubDevice(this.deviceRegistry, raw.slice("Bearer ".length));
  }

  private authenticatePrincipal(raw: string | undefined): HomeAssistantPrincipal | null {
    if (this.authorizedControlToken(raw)) {
      return {
        id: "PSFN gateway",
        entityIds: [...new Set(this.deviceRegistry.devices.flatMap((device) => device.homeAssistantEntityIds))],
      };
    }
    const device = this.authenticateDevice(raw);
    return device ? { id: device.deviceId, entityIds: device.homeAssistantEntityIds } : null;
  }

  private assertEntitiesAllowed(principal: HomeAssistantPrincipal, entityIds: readonly string[]): void {
    for (const entityId of entityIds) {
      if (!principal.entityIds.includes(entityId)) {
        throw new HttpInputError(403, "entity_not_allowed", `Home Assistant entity is not allowed for ${principal.id}: ${entityId}`);
      }
    }
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpInputError(415, "content_type", "Content-Type must be application/json");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > this.config.maxBodyBytes) {
        throw new HttpInputError(413, "body_too_large", "Request body exceeds configured limit");
      }
      chunks.push(bytes);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new HttpInputError(400, "invalid_json", "Request body must be valid JSON");
    }
    if (!isRecord(value)) {
      throw new HttpInputError(400, "invalid_request", "Request body must be a JSON object");
    }
    return value;
  }

  private remember(requestId: string, entry: IdempotencyEntry): void {
    this.idempotency.set(requestId, entry);
    if (this.idempotency.size <= MAX_IDEMPOTENCY_ENTRIES) return;
    const oldest = this.idempotency.keys().next().value as string | undefined;
    if (oldest) this.idempotency.delete(oldest);
  }

  private writeError(response: http.ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof HttpInputError
      ? error.status
      : error instanceof HomeAssistantUnavailableError
        ? 503
        : error instanceof HomeAssistantRequestError
          ? 400
          : 500;
    const type = error instanceof HttpInputError
      ? error.type
      : error instanceof HomeAssistantUnavailableError
        ? "home_assistant_unavailable"
        : error instanceof HomeAssistantRequestError
          ? "home_assistant_request"
          : "internal_error";
    const message = error instanceof Error ? error.message : "Internal Hub control error";
    response.statusCode = status;
    response.end(JSON.stringify({ error: { type, message } }));
  }
}

class HttpInputError extends Error {
  constructor(readonly status: number, readonly type: string, message: string) {
    super(message);
  }
}

function parseCallService(body: Record<string, unknown>): HomeAssistantCallServiceInput {
  const requestId = parseRequestId(body.requestId);
  const domain = parseEnum(body.domain, HOME_ASSISTANT_ALLOWED_DOMAINS, "domain") as HomeAssistantAllowedDomain;
  const service = parseEnum(body.service, HOME_ASSISTANT_ALLOWED_SERVICES, "service") as HomeAssistantAllowedService;
  if (service === "set_percentage" && domain !== "fan") {
    throw new HttpInputError(400, "invalid_service_domain", "set_percentage is only allowed for fan entities");
  }
  const entityIds = parseEntityIds(body.entityIds, false);
  for (const entityId of entityIds) {
    if (!entityId.startsWith(`${domain}.`)) {
      throw new HttpInputError(400, "invalid_entity_domain", `entityId ${entityId} does not belong to domain ${domain}`);
    }
  }
  const data = parseServiceData(body.data);
  return { requestId, domain, service, entityIds, ...(data ? { data } : {}) };
}

function parseRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    throw new HttpInputError(400, "invalid_request_id", "requestId must be a non-empty stable token");
  }
  return value;
}

function parseEntityIds(value: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_ENTITY_IDS) {
    throw new HttpInputError(400, "invalid_entity_ids", `entityIds must contain ${allowEmpty ? `0-${MAX_ENTITY_IDS}` : `1-${MAX_ENTITY_IDS}`} entries`);
  }
  const entityIds = [...new Set(value.map((entry) => {
    if (typeof entry !== "string" || !ENTITY_ID_PATTERN.test(entry)) {
      throw new HttpInputError(400, "invalid_entity_id", "entityIds must contain valid Home Assistant entity ids");
    }
    return entry;
  }))];
  return entityIds;
}

function parseServiceData(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new HttpInputError(400, "invalid_service_data", "data must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_SERVICE_DATA_KEYS.has(key)) {
      throw new HttpInputError(400, "service_data_key_denied", `Home Assistant service data key is not allowed: ${key}`);
    }
  }
  if ("percentage" in value && (
    typeof value.percentage !== "number"
    || !Number.isFinite(value.percentage)
    || value.percentage < 0
    || value.percentage > 100
  )) {
    throw new HttpInputError(400, "invalid_service_data", "percentage must be a number from 0 through 100");
  }
  return { ...value };
}

function parseEnum(value: unknown, allowed: readonly string[], field: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HttpInputError(400, `invalid_${field}`, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function hashCanonical(input: HomeAssistantCallServiceInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

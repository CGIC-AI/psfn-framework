import "dotenv/config";

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const rootDir = process.cwd();
const studioDir = path.join(rootDir, "dist", "device-studio");
const host = process.env.DEVICE_STUDIO_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.DEVICE_STUDIO_PORT || process.env.PORT || "8790", 10);
const maxJsonBodyBytes = 12 * 1024 * 1024;

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, `${JSON.stringify(payload)}\n`, "application/json; charset=utf-8");
}

function sendError(res, statusCode, code, message, extra = {}) {
  sendJson(res, statusCode, {
    ok: false,
    error: {
      code,
      message,
      ...extra,
    },
  });
}

function moduleUrl(...segments) {
  return pathToFileURL(path.join(rootDir, ...segments)).href;
}

async function readJsonBody(req) {
  const chunks = [];
  let receivedBytes = 0;

  for await (const chunk of req) {
    receivedBytes += chunk.length;
    if (receivedBytes > maxJsonBodyBytes) {
      const error = new Error(`Request body exceeds ${maxJsonBodyBytes} byte limit`);
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body);
  } catch (error) {
    const parseError = new Error("Request body must be valid JSON");
    parseError.code = "invalid_json";
    parseError.cause = error;
    throw parseError;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value) {
  return Array.isArray(value) ? value.map(readString).filter(Boolean) : [];
}

function requestMethodNotAllowed(res) {
  res.writeHead(405, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    allow: "POST",
  });
  res.end(`${JSON.stringify({
    ok: false,
    error: { code: "method_not_allowed", message: "Method not allowed" },
  })}\n`);
}

function sanitizeMessage(message) {
  const falKey = process.env.FAL_KEY;
  const withoutFalKey = falKey ? message.split(falKey).join("[redacted]") : message;
  return withoutFalKey
    .replace(/Authorization:\s*Key\s+[^\s"'<>]+/gi, "Authorization: Key [redacted]")
    .replace(/"authorization"\s*:\s*"Key\s+[^"]+"/gi, '"authorization":"Key [redacted]"')
    .slice(0, 2000);
}

function errorMessage(error, fallback = "Request failed") {
  return sanitizeMessage(error instanceof Error ? error.message : fallback);
}

async function handleSpriteGenerate(req, res) {
  if (req.method !== "POST") {
    requestMethodNotAllowed(res);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    handleJsonBodyError(res, error);
    return;
  }

  if (!isRecord(body)) {
    sendError(res, 400, "validation_error", "Request body must be a JSON object");
    return;
  }

  const mode = readString(body.mode);
  const allowedModes = new Set(["text-to-image", "image-to-image", "edit"]);
  if (!mode || !allowedModes.has(mode)) {
    sendError(res, 400, "validation_error", "mode must be one of text-to-image, image-to-image, edit", {
      issues: [{ path: "mode", message: "Unsupported or missing generation mode" }],
    });
    return;
  }

  if (!process.env.FAL_KEY || !process.env.FAL_KEY.trim()) {
    sendError(res, 503, "fal_unavailable", "FAL_KEY is required for FAL image generation");
    return;
  }

  try {
    const { FalImageProvider } = await import(moduleUrl("dist", "ts", "device-studio", "fal-provider.js"));
    const provider = new FalImageProvider({ apiKey: process.env.FAL_KEY });
    const imageInputs = mode === "text-to-image" ? {
      imageUrl: body.imageUrl,
      imageUrls: body.imageUrls,
    } : await normalizeFalImageInputs(body);
    const request = {
      modelId: body.modelId,
      prompt: body.prompt,
      seed: body.seed,
      options: body.options,
      ...imageInputs,
      provenance: body.provenance,
    };
    const result = mode === "text-to-image"
      ? await provider.generateTextToImage(request)
      : mode === "image-to-image"
        ? await provider.generateImageToImage(request)
        : await provider.editImage(request);

    sendJson(res, 200, { ok: true, result: await attachGeneratedImageDataUrls(result) });
  } catch (error) {
    const message = errorMessage(error, "FAL image generation failed");
    if (message.includes("FAL_KEY is required")) {
      sendError(res, 503, "fal_unavailable", message);
      return;
    }
    if (isFalValidationError(message)) {
      sendError(res, 400, "validation_error", message);
      return;
    }
    sendError(res, 502, "fal_error", message);
  }
}

async function normalizeFalImageInputs(body) {
  const imageInputs = [
    ...(readString(body.imageUrl) ? [readString(body.imageUrl)] : []),
    ...readStringArray(body.imageUrls),
  ];
  const normalized = await Promise.all(imageInputs.map((value, index) => (
    value.startsWith("data:") ? uploadFalDataUrl(value, index) : value
  )));
  if (normalized.length === 1) {
    return { imageUrl: normalized[0] };
  }
  if (normalized.length > 1) {
    return { imageUrls: normalized };
  }
  return {};
}

async function uploadFalDataUrl(value, index) {
  const { mediaType, bytes } = decodeImageDataUrl(value);
  const { fal } = await import("@fal-ai/client");
  fal.config({ credentials: process.env.FAL_KEY });
  const blob = new Blob([bytes], { type: mediaType });
  const extension = mediaType.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const file = new File([blob], `device-studio-reference-${Date.now()}-${index}.${extension}`, { type: mediaType });
  return fal.storage.upload(file, { lifecycle: { expiresIn: 60 * 60 * 6 } });
}

function decodeImageDataUrl(value) {
  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(value);
  if (!dataUrlMatch) {
    throw new Error("Reference upload must be a data URL or a URL");
  }
  const mediaType = (dataUrlMatch[1] || "application/octet-stream").toLowerCase();
  if (!mediaType.startsWith("image/")) {
    throw new Error(`Reference upload must be an image, received ${mediaType}`);
  }
  const isBase64 = Boolean(dataUrlMatch[2]);
  const payload = dataUrlMatch[3] ?? "";
  const bytes = isBase64
    ? Buffer.from(payload.replace(/\s+/g, ""), "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  if (bytes.byteLength === 0) {
    throw new Error("Reference upload is empty");
  }
  return { mediaType, bytes };
}

async function attachGeneratedImageDataUrls(result) {
  return {
    ...result,
    images: await Promise.all((result.images || []).map(async (image) => ({
      ...image,
      ...await readGeneratedImageDataUrl(image.url),
    }))),
  };
}

async function readGeneratedImageDataUrl(url) {
  const imageUrl = readString(url);
  if (!imageUrl) {
    return {};
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    return {
      packReady: false,
      packIssue: `Generated image download failed (${response.status})`,
    };
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  if (contentType !== "image/png") {
    return {
      packReady: false,
      packIssue: `Generated image is ${contentType}; import a PNG or configure the model for PNG output before packing`,
    };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxJsonBodyBytes) {
    return {
      packReady: false,
      packIssue: "Generated image exceeds Device Studio pack review size limit",
    };
  }

  return {
    packReady: true,
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
  };
}

function isFalValidationError(message) {
  return message.includes("FAL prompt is required")
    || message.includes("FAL modelId is required")
    || message.includes("FAL image-to-image/edit generation requires");
}

async function handleSpritePack(req, res) {
  if (req.method !== "POST") {
    requestMethodNotAllowed(res);
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    handleJsonBodyError(res, error);
    return;
  }

  if (!isRecord(body)) {
    sendError(res, 400, "validation_error", "Request body must be a JSON object");
    return;
  }

  const issues = [];
  const frames = Array.isArray(body.frames) ? body.frames : [];
  if (!Array.isArray(body.frames)) {
    issues.push({ path: "frames", message: "frames must be an array" });
  }

  const decodedFrames = [];
  for (const [index, frame] of frames.entries()) {
    if (!isRecord(frame)) {
      issues.push({ path: `frames[${index}]`, message: "Frame must be an object" });
      continue;
    }

    const dataUrl = readString(frame.dataUrl);
    if (!dataUrl) {
      issues.push({ path: `frames[${index}].dataUrl`, message: "Frame dataUrl is required" });
      continue;
    }

    try {
      decodedFrames.push({
        id: frame.id,
        kind: frame.kind,
        png: decodePngData(dataUrl),
        provenance: frame.provenance,
      });
    } catch (error) {
      issues.push({ path: `frames[${index}].dataUrl`, message: errorMessage(error, "Invalid PNG data") });
    }
  }

  if (issues.length > 0) {
    sendError(res, 400, "validation_error", "Sprite pack request is invalid", { issues });
    return;
  }

  try {
    const { packDeviceSpriteSheet } = await import(moduleUrl("dist", "ts", "device-studio", "sprites.js"));
    const result = packDeviceSpriteSheet({
      profileId: body.profileId,
      atlasId: body.atlasId,
      frames: decodedFrames,
    });

    sendJson(res, 200, {
      ok: true,
      atlasDataUrl: `data:image/png;base64,${Buffer.from(result.atlasPng).toString("base64")}`,
      manifest: result.manifest,
    });
  } catch (error) {
    const issues = isRecord(error) && Array.isArray(error.issues) ? error.issues : undefined;
    const statusCode = issues || error?.name === "SpriteSheetPackingError" ? 400 : 500;
    const code = statusCode === 400 ? "validation_error" : "sprite_pack_failed";
    sendError(res, statusCode, code, errorMessage(error, "Sprite packing failed"), issues ? { issues } : {});
  }
}

function decodePngData(value) {
  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(value);
  if (dataUrlMatch) {
    const mediaType = dataUrlMatch[1]?.toLowerCase();
    const isBase64 = Boolean(dataUrlMatch[2]);
    const payload = dataUrlMatch[3] ?? "";
    if (mediaType && mediaType !== "image/png") {
      throw new Error(`Expected image/png data URL, received ${mediaType}`);
    }
    if (!isBase64) {
      throw new Error("PNG data URL must be base64 encoded");
    }
    return decodeBase64Png(payload);
  }

  return decodeBase64Png(value);
}

function decodeBase64Png(value) {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) {
    throw new Error("PNG base64 data is empty");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("PNG data must be base64 encoded");
  }
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

function handleJsonBodyError(res, error) {
  if (error?.code === "body_too_large") {
    sendError(res, 413, "body_too_large", `Request body must be ${maxJsonBodyBytes} bytes or less`);
    return;
  }
  if (error?.code === "invalid_json") {
    sendError(res, 400, "invalid_json", "Request body must be valid JSON");
    return;
  }
  sendError(res, 400, "invalid_request", errorMessage(error, "Invalid request body"));
}

function resolveRequestPath(urlPathname) {
  const normalizedPath = decodeURIComponent(urlPathname) === "/"
    ? "/index.html"
    : decodeURIComponent(urlPathname);
  const candidate = path.normalize(path.join(studioDir, normalizedPath));
  if (!candidate.startsWith(`${studioDir}${path.sep}`)) {
    return undefined;
  }
  return candidate;
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    send(res, 400, "Bad request");
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

  if (requestUrl.pathname === "/api/sprites/generate") {
    await handleSpriteGenerate(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/sprites/pack") {
    await handleSpritePack(req, res);
    return;
  }

  const filePath = resolveRequestPath(requestUrl.pathname);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    send(res, 200, body, contentTypes.get(path.extname(filePath)) || "application/octet-stream");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      send(res, 404, "Not found");
      return;
    }
    console.error(error);
    send(res, 500, "Internal server error");
  }
});

server.listen(port, host, () => {
  console.log(`Device Studio: http://${host}:${port}`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

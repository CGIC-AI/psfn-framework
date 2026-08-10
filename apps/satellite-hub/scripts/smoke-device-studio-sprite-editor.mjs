import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { encodeRgbaPng } from "../dist/ts/device-studio/sprites.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const externalUrl = process.env.DEVICE_STUDIO_URL;
const smokePort = process.env.DEVICE_STUDIO_SMOKE_PORT || "8794";
const studioUrl = externalUrl || `http://127.0.0.1:${smokePort}`;

let server;
let browser;

try {
  if (!externalUrl) {
    server = spawn(process.execPath, ["scripts/serve-device-studio.mjs"], {
      cwd: rootDir,
      env: {
        ...process.env,
        DEVICE_STUDIO_HOST: "127.0.0.1",
        DEVICE_STUDIO_PORT: smokePort,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => process.stdout.write(chunk));
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
    await waitForUrl(studioUrl);
  }

  const sampleDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-studio-sprite-smoke-"));
  const referencePath = path.join(sampleDir, "reference.png");
  const sheetPath = path.join(sampleDir, "sheet.png");
  await fs.writeFile(referencePath, makePng(32, 32, (x, y) => [40 + x * 4, 90 + y * 4, 190, 255]));
  const sheetPng = makePng(64, 32, (x) => (x < 32 ? [235, 70, 80, 255] : [45, 160, 95, 255]));
  await fs.writeFile(sheetPath, sheetPng);
  const sheetDataUrl = `data:image/png;base64,${sheetPng.toString("base64")}`;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await page.goto(studioUrl, { waitUntil: "networkidle" });
  await page.locator("#sprite-heading").scrollIntoViewIfNeeded();
  await assertSpriteControlsFit(page);

  await page.setInputFiles("#sprite-reference-file", referencePath);
  await page.waitForFunction(() => document.querySelectorAll("#sprite-reference-grid .sprite-card").length === 1);
  const mode = await page.locator("#sprite-mode-select").inputValue();
  if (mode !== "edit") {
    throw new Error("Reference upload did not switch generation mode to edit");
  }
  const modelId = await page.locator("#sprite-model-input").inputValue();
  if (modelId !== "fal-ai/nano-banana/edit") {
    throw new Error(`Reference upload did not select an edit endpoint: ${modelId}`);
  }
  const frameCandidates = await page.locator("#sprite-candidate-grid .sprite-card").count();
  if (frameCandidates !== 0) {
    throw new Error("Reference upload created frame candidates");
  }

  let capturedGeneratePayload;
  await page.route("**/api/sprites/generate", async (route) => {
    capturedGeneratePayload = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        result: {
          modelId: capturedGeneratePayload.modelId,
          generatedAt: "2026-05-11T00:00:00.000Z",
          prompt: capturedGeneratePayload.prompt,
          images: [{
            url: "https://example.test/generated-sheet.png",
            dataUrl: sheetDataUrl,
            packReady: true,
          }],
        },
      }),
    });
  });
  await page.selectOption("#sprite-output-select", "sheet");
  await page.fill("#sprite-sheet-rows-input", "1");
  await page.fill("#sprite-sheet-cols-input", "2");
  await page.fill("#sprite-sheet-targets-input", "expression:happy\nviseme:a");
  await page.click("#generate-sprite-button");
  await page.waitForFunction(() => document.querySelectorAll("#sprite-sheet-grid .sprite-card").length === 1);
  assertSheetGeneratePayload(capturedGeneratePayload);
  await page.locator("#sprite-sheet-grid .sprite-card").getByRole("button", { name: "Slice" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#sprite-approved-grid .sprite-card[data-approved=\"true\"]").length === 2);

  const [packResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/sprites/pack")),
    page.click("#pack-sprites-button"),
  ]);
  if (!packResponse.ok()) {
    throw new Error(`Sprite pack endpoint failed with ${packResponse.status()}`);
  }

  await page.setViewportSize({ width: 390, height: 1000 });
  await page.locator("#sprite-heading").scrollIntoViewIfNeeded();
  const hasMobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (hasMobileOverflow) {
    throw new Error("Mobile viewport has horizontal overflow");
  }

  console.log("Device Studio sprite editor smoke passed");
} finally {
  await browser?.close();
  if (server && !server.killed) {
    server.kill("SIGTERM");
  }
}

function assertSheetGeneratePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Sprite sheet generate payload was not captured");
  }
  if (payload.mode !== "edit") {
    throw new Error(`Sprite sheet generation did not force edit mode: ${payload.mode}`);
  }
  if (payload.modelId !== "fal-ai/nano-banana/edit") {
    throw new Error(`Sprite sheet generation did not use edit endpoint: ${payload.modelId}`);
  }
  if (!Array.isArray(payload.imageUrls) && typeof payload.imageUrl !== "string") {
    throw new Error("Sprite sheet generation did not include reference image input");
  }
  const prompt = String(payload.prompt || "");
  for (const required of [
    "ONE single PNG sprite sheet image",
    "exact 2 columns by 1 rows grid",
    "not a single isolated sprite",
    "Use the uploaded reference image",
    "row 1, column 1: expression:happy",
    "row 1, column 2: viseme:a",
  ]) {
    if (!prompt.includes(required)) {
      throw new Error(`Sprite sheet prompt is missing: ${required}`);
    }
  }
  if (payload.options?.output_format !== "png" || payload.options?.num_images !== 1 || payload.options?.limit_generations !== true) {
    throw new Error(`Sprite sheet generation options are wrong: ${JSON.stringify(payload.options)}`);
  }
}

async function assertSpriteControlsFit(page) {
  const overflowing = await page.evaluate(() => {
    const panel = document.querySelector(".sprite-controls")?.getBoundingClientRect();
    if (!panel) return ["missing .sprite-controls"];
    return Array.from(document.querySelectorAll(".sprite-controls input, .sprite-controls textarea, .sprite-controls select, .sprite-controls button"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < panel.left - 1 || rect.right > panel.right + 1;
      })
      .map((element) => element.id || element.textContent || element.tagName);
  });
  if (overflowing.length > 0) {
    throw new Error(`Desktop sprite controls overflow: ${overflowing.join(", ")}`);
  }
}

async function waitForUrl(url) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
}

function makePng(width, height, colorAt) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue, alpha] = colorAt(x, y);
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = alpha;
    }
  }
  return Buffer.from(encodeRgbaPng({ width, height, data }));
}

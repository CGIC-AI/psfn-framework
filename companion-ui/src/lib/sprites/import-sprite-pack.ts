import { hasExactKeys, isRecord } from '../../../../src/shared/utils/types.js';
import { buildSpriteManifest, type SpriteManifest, type SpriteSheet } from './manifest.js';

export interface LocalSpritePack {
  readonly manifest: SpriteManifest;
  /** The receiver owns these URLs; dispose when replacing or leaving the account. */
  dispose(): void;
}

/** Imports a complete local pack without fetching any manifest-provided resource. */
export async function readLocalSpritePack(files: readonly File[]): Promise<LocalSpritePack> {
  const canonical = buildSpriteManifest();
  const sheetNames = Object.keys(canonical.sheets);
  const names = ['manifest.json', ...sheetNames.map(name => `${name}.png`)];
  const byName = new Map(files.map(file => [file.name, file]));
  if (files.length !== names.length || byName.size !== names.length
    || names.some(name => !byName.has(name))) {
    throw new Error('Select manifest.json, expr-mini.png, expr-avatar.png, tool.png and touch.png together.');
  }
  const manifestFile = byName.get('manifest.json')!;
  // Bound JSON before reading it using the fixed contract's serialized size.
  if (manifestFile.size > JSON.stringify(canonical).length * 4) {
    throw new Error('The sprite manifest is too large for this sprite layout.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await manifestFile.text()); }
  catch { throw new Error('manifest.json could not be read as JSON.'); }
  const manifest = validateManifest(parsed, canonical);

  for (const name of sheetNames) {
    const file = byName.get(`${name}.png`)!;
    const sheet = manifest.sheets[name]!;
    const width = sheet.cols * sheet.frameSize.w;
    const height = sheet.rows * sheet.frameSize.h;
    // Compressed sheets should fit within the canonical 8-bit RGBA pixel budget.
    if (file.size > width * height * 4) {
      throw new Error(`${name}.png is too large for its sprite layout.`);
    }
    const bytes = await file.arrayBuffer();
    validatePng(bytes, width, height, name);
  }

  const ownedUrls: string[] = [];
  function dispose() {
    for (const url of ownedUrls.splice(0)) URL.revokeObjectURL(url);
  }
  try {
    const sheets: Record<string, SpriteSheet> = {};
    for (const name of sheetNames) {
      const url = URL.createObjectURL(byName.get(`${name}.png`)!);
      ownedUrls.push(url);
      sheets[name] = { ...manifest.sheets[name]!, src: url };
    }
    return { manifest: { ...manifest, sheets }, dispose };
  } catch {
    dispose();
    throw new Error('The browser could not open these local sprite images.');
  }
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateManifest(value: unknown, canonical: SpriteManifest): SpriteManifest {
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(canonical))
    || value.version !== canonical.version || typeof value.placeholder !== 'boolean'
    || !validText(value.generator) || !isRecord(value.sheets) || !isRecord(value.entries)
    || !hasExactKeys(value.sheets, Object.keys(canonical.sheets))
    || !hasExactKeys(value.entries, Object.keys(canonical.entries))) {
    throw new Error('The sprite manifest does not match the supported sprite-pack format.');
  }
  const sheets: Record<string, SpriteSheet> = {};
  for (const [name, expected] of Object.entries(canonical.sheets)) {
    const sheet = value.sheets[name];
    if (!isRecord(sheet) || !hasExactKeys(sheet, Object.keys(expected))
      || (sheet.src !== expected.src && sheet.src !== `${name}.png`)
      || sheet.cols !== expected.cols || sheet.rows !== expected.rows
      || sheet.frameCount !== expected.frameCount || sheet.lazy !== expected.lazy
      || typeof sheet.placeholder !== 'boolean' || !isRecord(sheet.frameSize)
      || !hasExactKeys(sheet.frameSize, ['w', 'h'])
      || sheet.frameSize.w !== expected.frameSize.w || sheet.frameSize.h !== expected.frameSize.h) {
      throw new Error(`${name} must use its local PNG and the canonical sprite-sheet geometry.`);
    }
    sheets[name] = { ...expected, placeholder: sheet.placeholder };
  }
  const entries: Record<string, SpriteManifest['entries'][string]> = {};
  for (const [id, expected] of Object.entries(canonical.entries)) {
    const entry = value.entries[id];
    if (!isRecord(entry) || !hasExactKeys(entry, Object.keys(expected))
      || !validText(entry.label) || typeof entry.placeholder !== 'boolean'
      || !Array.isArray(entry.frames) || entry.frames.length !== expected.frames.length
      || entry.frames.some((frame, index) => frame !== expected.frames[index])
      || Object.entries(expected).some(([key, field]) =>
        key !== 'frames' && key !== 'label' && key !== 'placeholder' && entry[key] !== field)) {
      throw new Error(`${id} must keep the canonical animation and frame ordering.`);
    }
    entries[id] = { ...expected, label: entry.label, placeholder: entry.placeholder };
  }
  return { ...canonical, generator: value.generator, placeholder: value.placeholder, sheets, entries };
}

function validatePng(buffer: ArrayBuffer, width: number, height: number, name: string) {
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const view = new DataView(buffer);
  if (bytes.length < 33 || !signature.every((byte, index) => bytes[index] === byte)
    || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) {
    throw new Error(`${name}.png is not a valid PNG image header.`);
  }
  if (view.getUint32(16) !== width || view.getUint32(20) !== height) {
    throw new Error(`${name}.png must be exactly ${width} × ${height} pixels.`);
  }
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
  };
  if (!depths[bytes[25]!]?.includes(bytes[24]!) || bytes[26] !== 0 || bytes[27] !== 0
    || (bytes[28] !== 0 && bytes[28] !== 1)) {
    throw new Error(`${name}.png has an unsupported PNG image header.`);
  }
  let offset = 33;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset);
    const end = offset + size + 12;
    if (end > bytes.length) break;
    const kind = view.getUint32(offset + 4);
    if (kind === 0x49484452) break; // A second IHDR is not a valid PNG.
    if (kind === 0x49444154 && size > 0) imageData = true; // IDAT
    if (kind === 0x49454e44) { // IEND must terminate the selected file.
      if (imageData && size === 0 && end === bytes.length) return;
      break;
    }
    offset = end;
  }
  throw new Error(`${name}.png has incomplete or invalid PNG image data.`);
}

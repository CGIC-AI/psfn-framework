// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSpriteManifest } from './manifest.js';
import { readLocalSpritePack } from './import-sprite-pack.js';

const artDirectory = resolve(import.meta.dirname, '../../../public/sprites');

function makeFiles(manifest: unknown = buildSpriteManifest()) {
  return [
    new File([JSON.stringify(manifest)], 'manifest.json', { type: 'application/json' }),
    ...['expr-mini', 'expr-avatar', 'tool', 'touch'].map(name => new File([
      new Uint8Array(readFileSync(resolve(artDirectory, `${name}.png`))),
    ], `${name}.png`, { type: 'image/png' })),
  ];
}

afterEach(() => { vi.restoreAllMocks(); });

describe('local sprite-pack import', () => {
  it('accepts the actual canonical sheets, replaces only sources and disposes URLs exactly once', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((_blob) => `blob:local-${Math.random()}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const canonical = buildSpriteManifest({ placeholder: false });
    const pack = await readLocalSpritePack(makeFiles(canonical));
    expect(create).toHaveBeenCalledTimes(4);
    expect(pack.manifest.entries).toEqual(canonical.entries);
    expect(pack.manifest.placeholder).toBe(false);
    expect(Object.values(pack.manifest.sheets).every(sheet => sheet.src.startsWith('blob:local-'))).toBe(true);
    pack.dispose();
    pack.dispose();
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(Object.values(pack.manifest.sheets).map(sheet => sheet.src));
  });

  it('accepts selected-file basenames as resources without any network access', async () => {
    const manifest = JSON.parse(JSON.stringify(buildSpriteManifest()));
    for (const [name, sheet] of Object.entries(manifest.sheets) as Array<[string, { src: string }]>) sheet.src = `${name}.png`;
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const pack = await readLocalSpritePack(makeFiles(manifest));
    expect(fetch).not.toHaveBeenCalled();
    pack.dispose();
  });

  it.each(['missing', 'duplicate', 'extra', 'wrong name'])('rejects %s files before allocating a URL', async (condition) => {
    const files = makeFiles();
    if (condition === 'missing') files.pop();
    if (condition === 'duplicate') files[4] = files[1]!;
    if (condition === 'extra') files.push(new File(['extra'], 'extra.png'));
    if (condition === 'wrong name') files[1] = new File(['wrong'], '../expr-mini.png');
    const create = vi.spyOn(URL, 'createObjectURL');
    await expect(readLocalSpritePack(files)).rejects.toThrow('Select manifest.json');
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['https://example.com/art.png', '//example.com/art.png', '../expr-mini.png', 'sprites/../expr-mini.png', 'data:image/png;base64,AAA', 'blob:unowned', 'expr-mini.png?key=secret'])('rejects a nonlocal manifest source: %s', async (src) => {
    const manifest = JSON.parse(JSON.stringify(buildSpriteManifest()));
    manifest.sheets['expr-mini'].src = src;
    const create = vi.spyOn(URL, 'createObjectURL');
    await expect(readLocalSpritePack(makeFiles(manifest))).rejects.toThrow('local PNG');
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['geometry', 'frames', 'fps', 'unknown entry', 'extra property', 'null sheet'])('rejects %s contract drift', async (drift) => {
    const manifest = JSON.parse(JSON.stringify(buildSpriteManifest()));
    if (drift === 'geometry') manifest.sheets.tool.cols += 1;
    if (drift === 'frames') manifest.entries['expr.neutral.mini'].frames.reverse();
    if (drift === 'fps') manifest.entries['expr.neutral.mini'].fps = 300;
    if (drift === 'unknown entry') delete manifest.entries['expr.neutral.mini'];
    if (drift === 'extra property') manifest.sheets.tool.remote = 'https://example.com/';
    if (drift === 'null sheet') manifest.sheets.tool = null;
    const create = vi.spyOn(URL, 'createObjectURL');
    await expect(readLocalSpritePack(makeFiles(manifest))).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['bad signature', 'wrong dimensions', 'missing image data', 'truncated chunk'])('rejects PNG %s before allocating a URL', async (fault) => {
    const files = makeFiles();
    const original = new Uint8Array(await files[1]!.arrayBuffer());
    let bytes = original;
    if (fault === 'bad signature') bytes[0] = 0;
    if (fault === 'wrong dimensions') new DataView(bytes.buffer).setUint32(16, 4096);
    if (fault === 'missing image data') bytes = bytes.slice(0, 33);
    if (fault === 'truncated chunk') bytes = bytes.slice(0, bytes.length - 1);
    files[1] = new File([bytes], 'expr-mini.png', { type: 'image/png' });
    const create = vi.spyOn(URL, 'createObjectURL');
    await expect(readLocalSpritePack(files)).rejects.toThrow('expr-mini.png');
    expect(create).not.toHaveBeenCalled();
  });

  it('revokes partially allocated URLs when the browser cannot allocate the rest', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockImplementation(() => { throw new Error('allocation failed'); });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await expect(readLocalSpritePack(makeFiles())).rejects.toThrow('browser could not open');
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:first');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('mobile installation assets', () => {
  it('provides real correctly-sized PNG icons on the canonical application path', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8')) as {
      id: string; start_url: string; scope: string;
      icons: Array<{ src: string; type: string; sizes: string; purpose: string }>;
    };
    expect([manifest.id, manifest.start_url, manifest.scope]).toEqual(Array(3).fill('/companion-ui/'));
    const pngs = manifest.icons.filter(icon => icon.type === 'image/png');
    expect(pngs.some(icon => icon.sizes === '192x192' && icon.purpose === 'any')).toBe(true);
    expect(pngs.some(icon => icon.sizes === '512x512' && icon.purpose === 'any')).toBe(true);
    expect(pngs.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable')).toBe(true);
    for (const icon of pngs) {
      expect(icon.src.startsWith('/companion-ui/')).toBe(true);
      const png = readFileSync(resolve(root, 'public', icon.src.slice('/companion-ui/'.length)));
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
    }
    const appleIcon = readFileSync(resolve(root, 'public/apple-touch-icon.png'));
    expect([appleIcon.readUInt32BE(16), appleIcon.readUInt32BE(20)]).toEqual([180, 180]);
    expect(readFileSync(resolve(root, 'index.html'), 'utf8')).toContain('href="/companion-ui/apple-touch-icon.png"');
  });
});

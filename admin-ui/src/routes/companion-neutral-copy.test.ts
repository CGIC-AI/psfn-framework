import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONTROL_SURFACES = [
  './chat/+page.svelte',
  './episodic-memory/LazyPageContent.svelte',
  './evals/emotion-sidecar/+page.svelte',
  './wiki/+page.svelte',
  './wishlist/+page.svelte',
] as const;

describe('companion-neutral Garden copy', () => {
  for (const relativePath of CONTROL_SURFACES) {
    it(`${relativePath} does not hardcode a companion's gender`, async () => {
      const source = await readFile(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        'utf8',
      );

      expect(source).not.toMatch(/\b(?:she|her|hers|herself)\b/i);
    });
  }
});

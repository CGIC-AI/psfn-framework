import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const memoryPage = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const biographyPage = readFileSync(new URL('../biographical-profile/+page.svelte', import.meta.url), 'utf8');
const biographyPanel = readFileSync(new URL('./BiographicalClaimsPanel.svelte', import.meta.url), 'utf8');

// Retained as a source guard until a browser journey exercises the review
// request and disclosure grant. Server route tests separately check stale
// digests and redacted responses; they do not prove this client sends them.
describe('biography review client source guard', () => {
  it('keeps review redacted and bound to the displayed claim and source digests', () => {
    expect(memoryPage).not.toContain('<BiographicalClaimsPanel />');
    expect(biographyPage).toContain('<BiographicalClaimsPanel />');
    expect(biographyPanel).toContain('Source bodies never appear here');
    expect(biographyPanel).toContain('currentSourceSetDigest');
    expect(biographyPanel).toContain('claimDigest: detail.claim.claimDigest');
    expect(biographyPanel).toContain('hasActiveCurrentGrant()');
    expect(biographyPanel).not.toContain('sourceBody');
  });
});

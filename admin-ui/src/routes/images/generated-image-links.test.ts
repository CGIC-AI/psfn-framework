import { describe, expect, it } from 'vitest';
import { resolveGeneratedImageLinks, resolveGeneratedImageReferenceHref } from './generated-image-links';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const GARDEN_PATHNAME = `/companions/${COMPANION_ID}/garden/images`;

describe('generated image links', () => {
  it('scopes the Garden blob while leaving external source provenance external', () => {
    const links = resolveGeneratedImageLinks({
      url: '/api/admin/images/generated/image-1/blob',
      artifactRefs: [{
        kind: 'shared_image',
        url: 'https://v3b.fal.media/files/example/generated.png',
      }],
    }, GARDEN_PATHNAME);

    expect(links).toEqual({
      blobHref: `/companions/${COMPANION_ID}/garden/api/admin/images/generated/image-1/blob`,
      sourceHref: 'https://v3b.fal.media/files/example/generated.png',
    });
  });

  it('keeps root-absolute provenance references inside the companion Garden scope', () => {
    expect(resolveGeneratedImageReferenceHref(
      '/api/admin/images/generated/source-image/blob',
      GARDEN_PATHNAME,
    )).toBe(
      `/companions/${COMPANION_ID}/garden/api/admin/images/generated/source-image/blob`,
    );
  });

  it.each([
    'javascript:execute(1)',
    'data:image/png;base64,AA==',
    'file:///private/image.png',
    'https://user:secret@example.test/image.png',
    'https:\\example.test\\image.png',
    'https://exa\nmple.test/image.png',
    'https://example.test/im\u0085age.png',
    'not a URL',
    '//example.test/image.png',
    '/api//admin/images/source',
    '/api/admin/../images/source',
    '/api/admin/images/source#fragment',
  ])('rejects a malformed or disallowed provenance URL per item: %s', (url) => {
    expect(resolveGeneratedImageReferenceHref(url, GARDEN_PATHNAME)).toBeNull();
  });

  it('contains invalid links without aborting a mixed image collection', () => {
    const images = [
      {
        url: '/api/admin/images/generated/good/blob',
        artifactRefs: [{
          kind: 'shared_image' as const,
          url: 'https://cdn.discordapp.com/attachments/channel/image.png?ex=abc',
        }],
      },
      {
        url: 'data:image/png;base64,AA==',
        artifactRefs: [{ kind: 'shared_image' as const, url: 'javascript:execute(1)' }],
      },
      {
        url: '/api/admin/images/generated/also-good/blob',
        artifactRefs: [
          { kind: 'shared_image' as const, url: 'file:///private/image.png' },
          { kind: 'shared_image' as const, url: '/api/admin/images/shared/source' },
        ],
      },
    ];

    expect(images.map((image) => resolveGeneratedImageLinks(image, GARDEN_PATHNAME))).toEqual([
      {
        blobHref: `/companions/${COMPANION_ID}/garden/api/admin/images/generated/good/blob`,
        sourceHref: 'https://cdn.discordapp.com/attachments/channel/image.png?ex=abc',
      },
      { blobHref: null, sourceHref: null },
      {
        blobHref: `/companions/${COMPANION_ID}/garden/api/admin/images/generated/also-good/blob`,
        sourceHref: `/companions/${COMPANION_ID}/garden/api/admin/images/shared/source`,
      },
    ]);
  });

  it('contains malformed Garden paths but does not hide companion authorization failures', () => {
    expect(resolveGeneratedImageLinks({
      url: '/api/admin/%2e%2e/images/generated/invalid/blob',
      artifactRefs: [],
    }, GARDEN_PATHNAME)).toEqual({
      blobHref: null,
      sourceHref: null,
    });

    expect(() => resolveGeneratedImageLinks({
      url: '/api/admin/images/generated/image-1/blob',
      artifactRefs: [],
    }, '/fleet')).toThrow(/authorized companion route/u);
  });
});

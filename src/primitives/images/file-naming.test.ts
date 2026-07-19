import { describe, expect, it } from 'vitest';
import {
  buildImageFileName,
  deriveImageFileStem,
  inferImageExtension,
  sanitizeImageFileStem,
} from './file-naming.js';

describe('image file naming', () => {
  it('prefers recognized content types and falls back to URL extensions', () => {
    expect(inferImageExtension('https://example.test/output.unknown', 'image/jpeg; charset=binary'))
      .toBe('.jpg');
    expect(inferImageExtension('https://example.test/path/output.WEBP?token=secret', undefined))
      .toBe('.webp');
    expect(inferImageExtension('not a URL', undefined)).toBe('.png');
  });

  it('sanitizes stems and derives them from asset, request, then index', () => {
    expect(sanitizeImageFileStem('  my / image  ')).toBe('my-image');
    expect(sanitizeImageFileStem('***')).toBe('image');
    expect(deriveImageFileStem(
      { url: 'https://example.test/image', fileName: '../Provider File.PNG' },
      'request',
      0,
    )).toBe('Provider-File');
    expect(deriveImageFileStem({ url: 'https://example.test/image' }, 'request / id', 1))
      .toBe('request-id-2');
    expect(deriveImageFileStem({ url: 'https://example.test/image' }, undefined, 2))
      .toBe('image-3');
  });

  it('builds a stable stem, short identifier, and extension layout', () => {
    expect(buildImageFileName(
      { url: 'https://example.test/output.png', fileName: 'final image.png' },
      undefined,
      0,
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
    )).toBe('final-image-12345678.png');
  });
});

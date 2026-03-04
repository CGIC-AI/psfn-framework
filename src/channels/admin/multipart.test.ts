import { describe, it, expect } from 'vitest';
import { parseCard } from '@character-foundry/character-foundry/loader';
import { exportCard } from '@character-foundry/character-foundry/exporter';
import {
  extractBoundary,
  parseMultipartBody,
  validateAndParseCharacterCardFile,
  type ParsedFile,
} from './multipart.js';

// ── Helper: build a multipart body buffer ──

function buildMultipartBody(
  boundary: string,
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    content: string | Buffer;
  }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) {
      disposition += `; filename="${part.filename}"`;
    }
    chunks.push(Buffer.from(`${disposition}\r\n`));
    if (part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    }
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const TEST_CARD_V2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Multipart Test',
    description: 'A card used for multipart parser tests.',
    personality: 'Friendly and pragmatic.',
    scenario: 'Test scenario.',
    first_mes: 'Hello.',
    mes_example: '{{user}}: hi\n{{char}}: hello',
    system_prompt: 'Be concise.',
    post_history_instructions: 'Preserve continuity.',
    tags: ['tests'],
    creator: 'multipart-test-suite',
  },
} as const;

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5P4T0AAAAASUVORK5CYII=',
  'base64',
);

function toV3Card() {
  return parseCard(Buffer.from(JSON.stringify(TEST_CARD_V2), 'utf-8')).card;
}

describe('extractBoundary', () => {
  it('extracts boundary from standard Content-Type', () => {
    const result = extractBoundary('multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW');
    expect(result).toBe('----WebKitFormBoundary7MA4YWxkTrZu0gW');
  });

  it('extracts boundary with quotes', () => {
    const result = extractBoundary('multipart/form-data; boundary="abc123"');
    expect(result).toBe('abc123');
  });

  it('returns null for missing Content-Type', () => {
    expect(extractBoundary(undefined)).toBeNull();
  });

  it('returns null for non-multipart Content-Type', () => {
    expect(extractBoundary('application/json')).toBeNull();
  });

  it('returns null for multipart without boundary', () => {
    expect(extractBoundary('multipart/form-data')).toBeNull();
  });

  it('is case-insensitive for multipart/form-data prefix', () => {
    const result = extractBoundary('Multipart/Form-Data; boundary=test123');
    expect(result).toBe('test123');
  });
});

describe('parseMultipartBody', () => {
  const boundary = '----TestBoundary123';

  it('parses a single file upload', () => {
    const jsonContent = JSON.stringify({ name: 'TestBot', personality: 'Friendly' });
    const body = buildMultipartBody(boundary, [
      {
        name: 'file',
        filename: 'character.json',
        contentType: 'application/json',
        content: jsonContent,
      },
    ]);

    const result = parseMultipartBody(body, boundary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.fieldName).toBe('file');
    expect(result.file.filename).toBe('character.json');
    expect(result.file.contentType).toBe('application/json');
    expect(result.file.data.toString('utf-8')).toBe(jsonContent);
  });

  it('extracts the first file when multiple parts are present', () => {
    const body = buildMultipartBody(boundary, [
      { name: 'description', content: 'some text' },
      {
        name: 'file',
        filename: 'card.json',
        contentType: 'application/json',
        content: '{"name":"A"}',
      },
    ]);

    const result = parseMultipartBody(body, boundary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.filename).toBe('card.json');
  });

  it('returns error when no file field is found', () => {
    const body = buildMultipartBody(boundary, [
      { name: 'text', content: 'just some text' },
    ]);

    const result = parseMultipartBody(body, boundary);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No file found');
  });

  it('returns error for empty body', () => {
    const body = Buffer.from(`--${boundary}--\r\n`);
    const result = parseMultipartBody(body, boundary);
    expect(result.ok).toBe(false);
  });

  it('handles binary content in file data', () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    const body = buildMultipartBody(boundary, [
      {
        name: 'file',
        filename: 'data.bin',
        contentType: 'application/octet-stream',
        content: binaryData,
      },
    ]);

    const result = parseMultipartBody(body, boundary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.filename).toBe('data.bin');
    expect(Buffer.compare(result.file.data, binaryData)).toBe(0);
  });

  it('uses default content-type when not specified', () => {
    const body = buildMultipartBody(boundary, [
      {
        name: 'file',
        filename: 'test.json',
        content: '{}',
      },
    ]);

    const result = parseMultipartBody(body, boundary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.contentType).toBe('application/octet-stream');
  });
});

describe('validateAndParseCharacterCardFile', () => {
  it('accepts valid JSON character card files', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'card.json',
      contentType: 'application/json',
      data: Buffer.from(JSON.stringify(TEST_CARD_V2), 'utf-8'),
    };

    const result = validateAndParseCharacterCardFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const card = result.cardData as { data?: { name?: string } };
    expect(card.data?.name).toBe('Multipart Test');
    expect(result.filename).toBe('card.json');
    expect(result.containerFormat).toBe('json');
  });

  it('accepts PNG character card files', () => {
    const pngResult = exportCard(
      toV3Card(),
      [{ name: 'icon-main', type: 'icon', ext: 'png', data: ONE_BY_ONE_PNG, isMain: true }],
      { format: 'png' },
    );

    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'card.png',
      contentType: 'image/png',
      data: pngResult.buffer,
    };

    const result = validateAndParseCharacterCardFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const card = result.cardData as { data?: { name?: string } };
    expect(card.data?.name).toBe('Multipart Test');
    expect(result.containerFormat).toBe('png');
  });

  it('accepts CharX character card files', () => {
    const charxResult = exportCard(toV3Card(), [], { format: 'charx' });

    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'card.charx',
      contentType: 'application/octet-stream',
      data: charxResult.buffer,
    };

    const result = validateAndParseCharacterCardFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const card = result.cardData as { data?: { name?: string } };
    expect(card.data?.name).toBe('Multipart Test');
    expect(result.containerFormat).toBe('charx');
  });

  it('rejects unsupported filename extension', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'card.txt',
      contentType: 'text/plain',
      data: Buffer.from('not a card'),
    };

    const result = validateAndParseCharacterCardFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain('.json, .png, or .charx');
  });

  it('is case-insensitive for supported extension matching', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'CARD.JSON',
      contentType: 'application/json',
      data: Buffer.from(JSON.stringify(TEST_CARD_V2), 'utf-8'),
    };

    const result = validateAndParseCharacterCardFile(file);
    expect(result.ok).toBe(true);
  });

  it('rejects malformed character card content', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'broken.json',
      contentType: 'application/json',
      data: Buffer.from('not valid json {{{'),
    };

    const result = validateAndParseCharacterCardFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('could not be parsed');
  });
});

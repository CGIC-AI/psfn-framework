import { describe, it, expect } from 'vitest';
import {
  extractBoundary,
  parseMultipartBody,
  validateAndParseJsonFile,
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

describe('validateAndParseJsonFile', () => {
  it('accepts valid JSON file', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'card.json',
      contentType: 'application/json',
      data: Buffer.from('{"name":"Test","personality":"Friendly"}'),
    };

    const result = validateAndParseJsonFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toEqual({ name: 'Test', personality: 'Friendly' });
    expect(result.filename).toBe('card.json');
  });

  it('rejects non-JSON filename extension', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'card.txt',
      contentType: 'text/plain',
      data: Buffer.from('{"name":"Test"}'),
    };

    const result = validateAndParseJsonFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain('.json');
  });

  it('rejects invalid JSON content', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'card.json',
      contentType: 'application/json',
      data: Buffer.from('not valid json {{{'),
    };

    const result = validateAndParseJsonFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain('invalid JSON');
  });

  it('is case-insensitive for .json extension', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'CARD.JSON',
      contentType: 'application/json',
      data: Buffer.from('{"name":"Test"}'),
    };

    const result = validateAndParseJsonFile(file);
    expect(result.ok).toBe(true);
  });

  it('handles empty JSON object', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'empty.json',
      contentType: 'application/json',
      data: Buffer.from('{}'),
    };

    const result = validateAndParseJsonFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toEqual({});
  });

  it('handles JSON arrays', () => {
    const file: ParsedFile = {
      fieldName: 'file',
      filename: 'memories.json',
      contentType: 'application/json',
      data: Buffer.from('[{"type":"semantic","text":"hello"}]'),
    };

    const result = validateAndParseJsonFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Array.isArray(result.data)).toBe(true);
  });
});

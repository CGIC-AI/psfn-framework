import { describe, expect, it } from 'vitest';
import {
  parseDiscordDocumentBytes,
  toDiscordDocumentAttachmentCandidate,
} from './file-ingest.js';

function buildSimplePdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/g, match => `\\${match}`);
  const stream = `BT /F1 24 Tf 100 700 Td (${escaped}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
  ];

  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += `${object}\n`;
  }

  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

describe('Discord document file ingest', () => {
  it('parses UTF-8 text and markdown attachment bytes', async () => {
    await expect(
      parseDiscordDocumentBytes(Buffer.from('# Notes\n\nhello purr', 'utf8'), 'text/markdown'),
    ).resolves.toBe('# Notes\n\nhello purr');
  });

  it('parses PDF attachment text', async () => {
    const parsed = await parseDiscordDocumentBytes(buildSimplePdf('Hello PDF'), 'application/pdf');

    expect(parsed).toContain('Hello PDF');
  });

  it('infers supported document type from filename when Discord sends octet-stream', () => {
    expect(toDiscordDocumentAttachmentCandidate({
      id: 'att-1',
      name: 'briefing.md',
      url: 'https://cdn.discordapp.com/attachments/a/b/briefing.md',
      contentType: 'application/octet-stream',
      size: 42,
    })).toEqual(expect.objectContaining({
      id: 'att-1',
      name: 'briefing.md',
      contentType: 'text/markdown',
    }));
  });
});

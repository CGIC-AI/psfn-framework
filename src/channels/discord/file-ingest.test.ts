import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  appendDiscordDocumentIngestToContent,
  ingestDiscordDocumentAttachments,
  parseDiscordDocumentBytes,
  toDiscordDocumentAttachmentCandidate,
} from './file-ingest.js';
import { classifyDiscordAttachmentQuarantineRisk } from './file-quarantine.js';
import { DOCM_CONTENT_TYPE, DOCX_CONTENT_TYPE } from './office-document.js';

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

function buildZip(entries: Record<string, Buffer | string>): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const records: Array<{
    nameBytes: Buffer;
    data: Buffer;
    localHeaderOffset: number;
  }> = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const localHeaderOffset = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(data.byteLength, 18);
    header.writeUInt32LE(data.byteLength, 22);
    header.writeUInt16LE(nameBytes.byteLength, 26);
    header.writeUInt16LE(0, 28);
    localChunks.push(header, nameBytes, data);
    records.push({ nameBytes, data, localHeaderOffset });
    offset += header.byteLength + nameBytes.byteLength + data.byteLength;
  }

  const centralDirectoryOffset = offset;
  for (const record of records) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(record.data.byteLength, 20);
    header.writeUInt32LE(record.data.byteLength, 24);
    header.writeUInt16LE(record.nameBytes.byteLength, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(record.localHeaderOffset, 42);
    centralChunks.push(header, record.nameBytes);
    offset += header.byteLength + record.nameBytes.byteLength;
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDocx(paragraphs: string[], options: {
  macroEnabled?: boolean;
  extraEntries?: Record<string, Buffer | string>;
} = {}): Buffer {
  const mainDocumentContentType = options.macroEnabled
    ? 'application/vnd.ms-word.document.macroEnabled.main+xml'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
  const macroOverride = options.macroEnabled
    ? '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>'
    : '';
  const contentTypesXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    `<Override PartName="/word/document.xml" ContentType="${mainDocumentContentType}"/>`,
    macroOverride,
    '</Types>',
  ].join('');
  const bodyXml = paragraphs
    .map(paragraph => `<w:p><w:r><w:t>${xmlEscape(paragraph)}</w:t></w:r></w:p>`)
    .join('');
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:body>${bodyXml}</w:body>`,
    '</w:document>',
  ].join('');

  return buildZip({
    '[Content_Types].xml': contentTypesXml,
    '_rels/.rels': [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
      '</Relationships>',
    ].join(''),
    'word/document.xml': documentXml,
    ...(options.extraEntries ?? {}),
  });
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

  it('parses DOCX attachment text', async () => {
    const parsed = await parseDiscordDocumentBytes(
      buildDocx(['Hello DOCX', 'Second paragraph & more']),
      DOCX_CONTENT_TYPE,
    );

    expect(parsed).toContain('Hello DOCX');
    expect(parsed).toContain('Second paragraph & more');
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

    expect(toDiscordDocumentAttachmentCandidate({
      id: 'att-docx',
      name: 'briefing.docx',
      url: 'https://cdn.discordapp.com/attachments/a/b/briefing.docx',
      contentType: 'application/octet-stream',
      size: 128,
    })).toEqual(expect.objectContaining({
      id: 'att-docx',
      name: 'briefing.docx',
      contentType: DOCX_CONTENT_TYPE,
    }));
  });

  it('saves DOCX originals and parsed sidecars for prompt context', async () => {
    const personalFilesDir = mkdtempSync(join(tmpdir(), 'psfn-discord-docx-'));
    const originalFetch = globalThis.fetch;
    const docx = buildDocx(['Office briefing', 'DOCX text enters prompt safely']);
    const fetchMock = vi.fn(async () => new Response(docx, {
      headers: { 'content-type': DOCX_CONTENT_TYPE },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const summary = await ingestDiscordDocumentAttachments([{
        id: 'att-docx',
        name: 'briefing.docx',
        url: 'https://cdn.discordapp.com/attachments/a/b/briefing.docx',
        contentType: DOCX_CONTENT_TYPE,
        declaredContentType: DOCX_CONTENT_TYPE,
        sizeBytes: docx.byteLength,
      }], {
        personalFilesDir,
        channelId: 'discord-channel',
        messageId: 'message-docx',
        authorId: 'user-1',
        createdAt: new Date('2026-06-29T12:00:00.000Z'),
      });

      expect(summary.quarantined).toHaveLength(0);
      expect(summary.failures).toHaveLength(0);
      expect(summary.results).toHaveLength(1);
      const result = summary.results[0]!;
      expect(result.parsedText).toContain('Office briefing');
      expect(result.parsedText).toContain('DOCX text enters prompt safely');
      expect(result.truncatedForPrompt).toBe(false);
      expect(result.attachment.localPath).toContain(join(personalFilesDir, 'downloads', 'discord', '2026-06-29'));
      const localPath = result.attachment.localPath!;
      expect(readFileSync(localPath)).toEqual(docx);
      expect(result.parsedTextPath).toBe(`${localPath}.parsed.txt`);
      expect(readFileSync(result.parsedTextPath, 'utf8')).toContain('DOCX text enters prompt safely');

      const promptText = appendDiscordDocumentIngestToContent('please inspect this', summary);
      expect(promptText).toContain('[Attached file: briefing.docx]');
      expect(promptText).toContain('Office briefing');
      expect(promptText).toContain('DOCX text enters prompt safely');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      rmSync(personalFilesDir, { recursive: true, force: true });
    }
  });

  it('allows clean DOCX containers through quarantine inspection', () => {
    const decision = classifyDiscordAttachmentQuarantineRisk({
      name: 'briefing.docx',
      contentType: DOCX_CONTENT_TYPE,
      declaredContentType: DOCX_CONTENT_TYPE,
      bytes: buildDocx(['Clean Office text']),
    });

    expect(decision.quarantined).toBe(false);
    expect(decision.sniffedContentType).toBe(DOCX_CONTENT_TYPE);
  });

  it('quarantines shebang scripts and withholds the body from prompt context', async () => {
    const personalFilesDir = mkdtempSync(join(tmpdir(), 'psfn-discord-quarantine-'));
    const originalFetch = globalThis.fetch;
    const script = '#!/bin/sh\necho SHOULD_NOT_ENTER_PROMPT\n';
    const fetchMock = vi.fn(async () => new Response(script, {
      headers: { 'content-type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const summary = await ingestDiscordDocumentAttachments([{
        id: 'att-script',
        name: 'notes.txt',
        url: 'https://cdn.discordapp.com/attachments/a/b/notes.txt',
        contentType: 'text/plain',
        declaredContentType: 'text/plain',
        sizeBytes: script.length,
      }], {
        personalFilesDir,
        channelId: 'discord-channel',
        messageId: 'message-1',
        authorId: 'user-1',
        createdAt: new Date('2026-06-29T12:00:00.000Z'),
      });

      expect(summary.results).toHaveLength(0);
      expect(summary.failures).toHaveLength(0);
      expect(summary.quarantined).toHaveLength(1);
      const quarantined = summary.quarantined[0]!;
      expect(quarantined.status).toBe('quarantined_pending_review');
      expect(quarantined.reasons).toEqual(expect.arrayContaining([
        'shebang',
        'mime_sniff_mismatch:declared=text/plain;sniffed=text/x-shellscript',
      ]));
      expect(quarantined.quarantinePath).toContain(join(personalFilesDir, 'downloads', 'quarantine', 'discord'));
      expect(existsSync(quarantined.quarantinePath)).toBe(true);
      expect(readFileSync(quarantined.quarantinePath, 'utf8')).toBe(script);

      const metadata = JSON.parse(readFileSync(quarantined.metadataPath, 'utf8')) as {
        status: string;
        review: { status: string };
        reasons: string[];
      };
      expect(metadata.status).toBe('quarantined_pending_review');
      expect(metadata.review.status).toBe('quarantined_pending_review');
      expect(metadata.reasons).toContain('shebang');

      const promptText = appendDiscordDocumentIngestToContent('please inspect this', summary);
      expect(promptText).toContain('[Attached file quarantined: notes.txt]');
      expect(promptText).toContain(`SHA-256: ${quarantined.sha256}`);
      expect(promptText).toContain('Quarantine reasons:');
      expect(promptText).not.toContain('SHOULD_NOT_ENTER_PROMPT');
      expect(promptText).not.toContain(quarantined.quarantinePath);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      rmSync(personalFilesDir, { recursive: true, force: true });
    }
  });

  it('detects extension spoofing and MIME/sniff mismatch before parsing', () => {
    const decision = classifyDiscordAttachmentQuarantineRisk({
      name: 'release-notes.md',
      contentType: 'text/markdown',
      declaredContentType: 'text/markdown',
      bytes: buildZip({
        'scripts/install.sh': '#!/bin/sh\nexit 0\n',
      }),
    });

    expect(decision.quarantined).toBe(true);
    expect(decision.sniffedContentType).toBe('application/zip');
    expect(decision.reasons).toEqual(expect.arrayContaining([
      'archive_signature:application/zip',
      'extension_sniff_mismatch:expected=text/markdown;sniffed=application/zip',
      'mime_sniff_mismatch:declared=text/markdown;sniffed=application/zip',
    ]));
    expect(decision.reasons.some(reason => reason.includes('archive_contains_risky_entry:scripts/install.sh'))).toBe(true);
  });

  it('detects archives containing skill and plugin manifests', () => {
    const decision = classifyDiscordAttachmentQuarantineRisk({
      name: 'bundle.zip',
      contentType: 'application/zip',
      declaredContentType: 'application/zip',
      bytes: buildZip({
        'skills/ops/SKILL.md': '# Ops skill\n',
        '.codex-plugin/plugin.json': '{"name":"demo","version":"0.1.0"}\n',
      }),
    });

    expect(decision.quarantined).toBe(true);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      'archive_extension:.zip',
      'archive_mime:application/zip',
      'archive_signature:application/zip',
    ]));
    expect(decision.reasons.some(reason => reason.includes('skills/ops/SKILL.md(skill_manifest_name)'))).toBe(true);
    expect(decision.reasons.some(reason => reason.includes('.codex-plugin/plugin.json(plugin_manifest_name)'))).toBe(true);
  });

  it('quarantines macro-enabled Office containers and withholds parsed body text', async () => {
    const personalFilesDir = mkdtempSync(join(tmpdir(), 'psfn-discord-docm-quarantine-'));
    const originalFetch = globalThis.fetch;
    const docm = buildDocx(['MACRO_BODY_SHOULD_NOT_ENTER_PROMPT'], {
      macroEnabled: true,
      extraEntries: {
        'word/vbaProject.bin': Buffer.from([0, 1, 2, 3]),
      },
    });
    const fetchMock = vi.fn(async () => new Response(docm, {
      headers: { 'content-type': DOCM_CONTENT_TYPE },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const summary = await ingestDiscordDocumentAttachments([{
        id: 'att-docm',
        name: 'macro.docm',
        url: 'https://cdn.discordapp.com/attachments/a/b/macro.docm',
        contentType: DOCM_CONTENT_TYPE,
        declaredContentType: DOCM_CONTENT_TYPE,
        sizeBytes: docm.byteLength,
      }], {
        personalFilesDir,
        channelId: 'discord-channel',
        messageId: 'message-docm',
        authorId: 'user-1',
        createdAt: new Date('2026-06-29T12:00:00.000Z'),
      });

      expect(summary.results).toHaveLength(0);
      expect(summary.failures).toHaveLength(0);
      expect(summary.quarantined).toHaveLength(1);
      const quarantined = summary.quarantined[0]!;
      expect(quarantined.sniffedContentType).toBe(DOCM_CONTENT_TYPE);
      expect(quarantined.reasons).toEqual(expect.arrayContaining([
        'office_macro_enabled',
        'office_macro_entry:word/vbaProject.bin',
        'office_macro_or_legacy_extension:.docm',
        `office_macro_or_legacy_mime:${DOCM_CONTENT_TYPE}`,
      ]));
      expect(quarantined.reasons).not.toContain('archive_signature:application/zip');
      expect(existsSync(quarantined.quarantinePath)).toBe(true);

      await expect(parseDiscordDocumentBytes(docm, DOCX_CONTENT_TYPE)).rejects.toThrow(
        'unsupported or unsafe Office document container',
      );
      const promptText = appendDiscordDocumentIngestToContent('please inspect this', summary);
      expect(promptText).toContain('[Attached file quarantined: macro.docm]');
      expect(promptText).not.toContain('MACRO_BODY_SHOULD_NOT_ENTER_PROMPT');
      expect(promptText).not.toContain(quarantined.quarantinePath);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      rmSync(personalFilesDir, { recursive: true, force: true });
    }
  });

  it('detects plugin manifest content and executable mode bits', () => {
    const pluginDecision = classifyDiscordAttachmentQuarantineRisk({
      name: 'plugin.json',
      contentType: 'application/json',
      declaredContentType: 'application/json',
      bytes: Buffer.from(JSON.stringify({
        name: 'demo-plugin',
        version: '0.1.0',
        skills: './skills',
        interface: { displayName: 'Demo' },
      })),
    });
    expect(pluginDecision.quarantined).toBe(true);
    expect(pluginDecision.reasons).toEqual(expect.arrayContaining([
      'plugin_manifest_name',
      'plugin_manifest_content',
    ]));

    const executableDecision = classifyDiscordAttachmentQuarantineRisk({
      name: 'README.txt',
      contentType: 'text/plain',
      declaredContentType: 'text/plain',
      bytes: Buffer.from('plain text\n'),
      mode: 0o755,
    });
    expect(executableDecision.quarantined).toBe(true);
    expect(executableDecision.reasons).toContain('executable_mode_bits');
  });
});

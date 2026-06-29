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

function buildLocalHeaderZip(entries: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(data.byteLength, 18);
    header.writeUInt32LE(data.byteLength, 22);
    header.writeUInt16LE(nameBytes.byteLength, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, nameBytes, data);
  }
  return Buffer.concat(chunks);
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
      bytes: buildLocalHeaderZip({
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
      bytes: buildLocalHeaderZip({
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

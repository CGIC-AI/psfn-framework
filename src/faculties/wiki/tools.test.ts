import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { TextContent } from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WikiStore } from './store.js';
import { createWikiTool } from './tools.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((content): content is TextContent => content.type === 'text')
    .map(content => content.text)
    .join('');
}

describe('wiki tool', () => {
  let tempDir: string;
  let store: WikiStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wiki-tool-'));
    store = new WikiStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes, reads, searches, and lists internal wiki documents with boundary labels', async () => {
    const tool = createWikiTool(store);

    const written = JSON.parse(resultText(await tool.execute('write', {
      action: 'write',
      title: 'Garden Knowledge Surface',
      body: 'Garden should show wiki knowledge separately from memory.',
      tags: ['garden', 'wiki'],
    }))) as {
      action: string;
      document: { id: string; title: string; sourceClass: string };
      boundary: string;
    };
    expect(written.action).toBe('write');
    expect(written.document).toMatchObject({
      id: 'garden-knowledge-surface',
      sourceClass: 'companion_authored_note',
    });
    expect(written.boundary).toContain('no L2 memory was created');

    const read = JSON.parse(resultText(await tool.execute('read', {
      action: 'read',
      id: written.document.id,
    }))) as { document: { body: string }; boundary: string };
    expect(read.document.body).toContain('separately from memory');
    expect(read.boundary).toContain('not transcript memory');

    const searched = JSON.parse(resultText(await tool.execute('search', {
      query: 'Garden',
    }))) as { count: number; boundary: string; matches: Array<{ id: string }> };
    expect(searched.count).toBe(1);
    expect(searched.matches[0]?.id).toBe(written.document.id);
    expect(searched.boundary).toContain('not lived memory');

    const listed = JSON.parse(resultText(await tool.execute('list', {}))) as {
      documents: Array<{ id: string }>;
      boundary: string;
    };
    expect(listed.documents.map(document => document.id)).toEqual([written.document.id]);
    expect(listed.boundary).toContain('separate from L0/L0.1/L2 memory');
  });

  it('fails closed when imports omit source provenance', async () => {
    const tool = createWikiTool(store);
    const failed = resultText(await tool.execute('import-missing-provenance', {
      action: 'import',
      title: 'Vault Import',
      body: 'External note body.',
      source_class: 'imported_partner_vault_note',
    }));

    expect(failed).toContain('requires at least one provenance ref');

    const imported = JSON.parse(resultText(await tool.execute('import', {
      action: 'import',
      title: 'Vault Import',
      body: 'External note body.',
      source_class: 'imported_partner_vault_note',
      provenance_refs: ['vault:partner:Vault Import.md'],
    }))) as { document: { sourceClass: string; provenanceRefs: string[] } };
    expect(imported.document.sourceClass).toBe('imported_partner_vault_note');
    expect(imported.document.provenanceRefs).toEqual(['vault:partner:Vault Import.md']);
  });
});

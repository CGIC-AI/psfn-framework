// ── Adapter-parity acceptance test (htm9.9) ──
//
// The centerpiece of the file-ingestion bead: the SAME fixture file pushed
// through the Discord, Telegram, and API adapters' ingest paths must yield
//   1. identical parsed text,
//   2. identical envelope fields (minus channel origin metadata), and
//   3. the identical screening decision,
// because all three now converge on the shared file-ingest faculty. Each
// channel path starts from its adapter's OWN candidate mapper — the exact
// code the adapter runs — so a mapper divergence (content-type inference,
// declared MIME handling) fails this test, not just a unit test of the core.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Message } from 'discord.js';
import { extractDiscordDocumentAttachmentCandidates } from '../../channels/discord/attachments.js';
import { toTelegramDocumentCandidate, TELEGRAM_FILE_URL_PREFIX } from '../../channels/telegram/adapter.js';
import { getMessageFileParts } from '../../channels/api/server/session.js';
import {
  createIntakeScreeningService,
  renderIntakeWithheldContentPlaceholder,
  type IntakeScreeningService,
} from '../../core/cogsec/intake/screening.js';
import { createIntakeL1Scanner } from '../../core/cogsec/intake/scanners/index.js';
import { validateIntakePolicy } from '../../system/config/intake-policy-config.js';
import {
  ingestDocumentAttachments,
  screenDocumentIngestSummary,
  type DocumentAttachmentCandidate,
  type DocumentIngestChannel,
  type ScreenedDocumentIngest,
} from './document-ingest.js';

const FIXTURES_DIR = join(import.meta.dirname, 'test-fixtures');

interface Fixture {
  name: string;
  bytes: Buffer;
  /** What every channel must extract from the file. */
  expectParsedContains: string[];
  /** Expected screening decision state in enforce mode. */
  expectState: 'released' | 'quarantined';
}

const FIXTURES: Fixture[] = [
  {
    name: 'sample.md',
    bytes: readFileSync(join(FIXTURES_DIR, 'sample.md')),
    expectParsedContains: ['# Parity briefing', 'parse identically on every channel'],
    expectState: 'released',
  },
  {
    name: 'sample.csv',
    bytes: readFileSync(join(FIXTURES_DIR, 'sample.csv')),
    expectParsedContains: ['quarter,revenue', 'Q2,104'],
    expectState: 'released',
  },
  {
    name: 'sample.pdf',
    bytes: readFileSync(join(FIXTURES_DIR, 'sample.pdf')),
    expectParsedContains: ['Hello PSFN parity fixture'],
    expectState: 'released',
  },
  {
    name: 'sample.docx',
    bytes: readFileSync(join(FIXTURES_DIR, 'sample.docx')),
    expectParsedContains: ['PSFN parity briefing', 'Same file, three channels, one pipeline.'],
    expectState: 'released',
  },
  {
    // Real indirect-injection payload: binary quarantine passes (clean
    // markdown), the SCREENING layer must quarantine it on every channel.
    name: 'injection.md',
    bytes: readFileSync(join(FIXTURES_DIR, 'injection.md')),
    expectParsedContains: [],
    expectState: 'quarantined',
  },
];

function makeScreening(): IntakeScreeningService {
  const seed = JSON.parse(
    readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
  ) as Record<string, unknown>;
  return createIntakeScreeningService({
    policy: validateIntakePolicy({ ...seed, mode: 'enforce' }, 'intake-policy.parity-test'),
    l1: createIntakeL1Scanner({
      rulesPath: join(process.cwd(), 'config', 'intake-l1-rules.json'),
      reloadCheckIntervalMs: -1,
    }),
    actor: 'test:intake-screening',
  });
}

// ── Per-adapter candidate mappers (the adapters' own code) ──

function discordCandidates(fixture: Fixture): DocumentAttachmentCandidate[] {
  const msg = {
    attachments: new Map([[
      'att-1',
      {
        id: 'att-1',
        name: fixture.name,
        url: `https://cdn.discordapp.com/attachments/a/b/${fixture.name}`,
        proxyURL: null,
        // Discord frequently declares octet-stream; format inference must not
        // depend on the channel's declared MIME.
        contentType: 'application/octet-stream',
        size: fixture.bytes.byteLength,
      },
    ]]),
  } as unknown as Message;
  return extractDiscordDocumentAttachmentCandidates(msg);
}

function telegramCandidates(fixture: Fixture): DocumentAttachmentCandidate[] {
  const candidate = toTelegramDocumentCandidate({
    file_id: 'file-1',
    file_name: fixture.name,
    mime_type: 'application/octet-stream',
    file_size: fixture.bytes.byteLength,
  });
  return candidate ? [candidate] : [];
}

function apiCandidates(fixture: Fixture): DocumentAttachmentCandidate[] {
  return getMessageFileParts({
    role: 'user',
    content: [{
      type: 'file',
      file: {
        filename: fixture.name,
        file_data: fixture.bytes.toString('base64'),
      },
    }],
  }).candidates;
}

// ── Shared ingest driver ──

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function ingestVia(
  channel: DocumentIngestChannel,
  candidates: DocumentAttachmentCandidate[],
  fixture: Fixture,
  screening: IntakeScreeningService,
): Promise<ScreenedDocumentIngest> {
  const personalFilesDir = mkdtempSync(join(tmpdir(), `psfn-parity-${channel}-`));
  tempDirs.push(personalFilesDir);
  const summary = await ingestDocumentAttachments(candidates, {
    channel,
    personalFilesDir,
    channelId: `${channel}-channel`,
    messageId: 'msg-1',
    authorId: 'author-1',
    createdAt: new Date('2026-07-09T12:00:00.000Z'),
    // Discord/Telegram download through their SSRF-guarded ports in
    // production; the parity test serves identical bytes for both. The API
    // path carries bytes inline and must not need a fetch port at all.
    ...(channel === 'api' ? {} : {
      fetchResource: async () => ({
        ok: true,
        status: 200,
        bytes: fixture.bytes,
        contentType: 'application/octet-stream',
      }),
    }),
  });
  return screenDocumentIngestSummary(summary, screening, {
    channel,
    channelId: `${channel}-channel`,
    messageId: 'msg-1',
    attachmentIndexBase: 0,
  });
}

describe('adapter parity: one file, three channels, one pipeline (htm9.9)', () => {
  const screening = makeScreening();

  for (const fixture of FIXTURES) {
    it(`ingests ${fixture.name} identically via Discord, Telegram, and API`, async () => {
      const perChannel = {
        discord: await ingestVia('discord', discordCandidates(fixture), fixture, screening),
        telegram: await ingestVia('telegram', telegramCandidates(fixture), fixture, screening),
        api: await ingestVia('api', apiCandidates(fixture), fixture, screening),
      };

      for (const [channel, screened] of Object.entries(perChannel)) {
        expect(screened.summary.failures, `${channel} failures`).toEqual([]);
        expect(screened.summary.quarantined, `${channel} binary quarantine`).toEqual([]);
        expect(screened.summary.results, `${channel} results`).toHaveLength(1);
        expect(screened.snapshots, `${channel} snapshots`).toHaveLength(1);
      }

      const [discord, telegram, api] = [perChannel.discord, perChannel.telegram, perChannel.api];

      // 1. Same parsed text everywhere.
      const parsed = discord.summary.results[0]!.parsedText;
      expect(telegram.summary.results[0]!.parsedText).toBe(parsed);
      expect(api.summary.results[0]!.parsedText).toBe(parsed);
      for (const expected of fixture.expectParsedContains) {
        expect(parsed).toContain(expected);
      }

      // 2. Same envelope fields, minus channel origin metadata. The subject
      //    and envelopeId are per-message/per-envelope; everything the sink
      //    gates read must match.
      const project = (screened: ScreenedDocumentIngest) => {
        const snapshot = screened.snapshots[0]!;
        return {
          sourceClass: snapshot.sourceClass,
          sourceRiskTier: snapshot.sourceRiskTier,
          state: snapshot.state,
          riskLabels: [...snapshot.riskLabels].sort(),
          subject: snapshot.subject,
        };
      };
      const discordEnvelope = project(discord);
      expect(project(telegram)).toEqual(discordEnvelope);
      expect(project(api)).toEqual(discordEnvelope);
      expect(discordEnvelope.sourceClass).toBe('document');
      expect(discordEnvelope.state).toBe(fixture.expectState);

      // 3. Same screening decision and same effective prompt text.
      const promptText = discord.summary.results[0]!.promptText;
      expect(telegram.summary.results[0]!.promptText).toBe(promptText);
      expect(api.summary.results[0]!.promptText).toBe(promptText);
      if (fixture.expectState === 'quarantined') {
        // Enforce mode: the hostile parsed text is withheld on EVERY channel.
        expect(promptText).toBe(renderIntakeWithheldContentPlaceholder());
        expect(promptText).not.toContain('ignore all previous instructions');
      } else {
        expect(promptText).toBe(parsed);
      }
    });
  }

  it('keeps channel provenance distinct in origin metadata (not part of parity)', async () => {
    const fixture = FIXTURES[0]!;
    const screened = await ingestVia('telegram', telegramCandidates(fixture), fixture, screening);
    expect(screened.summary.results[0]!.attachment.url).toBe(`${TELEGRAM_FILE_URL_PREFIX}file-1`);
    // The telegram download dir is channel-scoped on disk.
    expect(screened.summary.results[0]!.attachment.localPath).toContain(join('downloads', 'telegram'));
  });
});

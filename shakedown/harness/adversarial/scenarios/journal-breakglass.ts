// Class 6 — journal / private-space read attempts via the admin surface.
//
// Seam: src/operator/garden/services/privacy-break-glass-service.ts (57gt) —
// companion journal / private-space reads through the Garden admin surface are
// default-DENY. An admin session cannot read a private reflection journal on
// ordinary (oauth) authority; it must first clear a webauthn-UV break-glass
// step, and even then the disclosure is a single-use, two-step-bound reveal of
// exactly the requested window. The scenarios drive the REAL service with faked
// stores (no DB) and assert the default-deny and single-use invariants.

import { AdminPrivacyBreakGlassService } from '../../../../src/operator/garden/services/privacy-break-glass-service.ts';
import {
  BG_NOW,
  BG_REASON,
  buildBreakGlassContext,
  buildJournalEntries,
} from '../lib/breakglass-context.ts';
import type { AdversarialScenario } from '../lib/scenario.ts';

const CLASS = 6;
const CLASS_NAME = 'Journal / private-space read via admin surface';
const SEAM = 'privacy break-glass — src/operator/garden/services/privacy-break-glass-service.ts (57gt)';

function makeService(): {
  begin: (input: unknown) => Promise<{ ok: boolean; code?: string; confirmToken?: string }>;
  decide: (input: unknown) => Promise<{ ok: boolean; code?: string; disclosure?: { kind?: string } }>;
} {
  const entries = buildJournalEntries();
  const service = new AdminPrivacyBreakGlassService({
    memoryStore: {
      getById: async () => null,
      getMemorySubjectClassification: async () => null,
      getContactProfile: async () => null,
    },
    journalReader: {
      listStream: (stream: string, limit: number) => (stream === 'reflection-journal' ? entries.slice(0, limit) : []),
    },
    confirmTtlMs: 60_000,
    now: () => BG_NOW,
    randomBytes: () => Buffer.alloc(32, 0xab),
  } as never) as never as {
    begin: (input: unknown) => Promise<{ ok: boolean; code?: string; confirmToken?: string }>;
    decide: (input: unknown) => Promise<{ ok: boolean; code?: string; disclosure?: { kind?: string } }>;
  };
  return service;
}

export const scenarios: AdversarialScenario[] = [
  {
    id: 's6_journal_read_default_deny',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'An admin session (ordinary oauth authority) tries to read the companion private reflection journal.',
    expectation: 'Denied by default: without a prior webauthn-UV break-glass authority the read is refused (HTTP 403).',
    async run(t) {
      const service = makeService();
      const denied = await service.begin({
        resourceKind: 'journal',
        resourceId: 'reflection-journal',
        request: BG_REASON,
        context: buildBreakGlassContext({ kind: 'journal', phase: 'confirm', resourceId: 'reflection-journal', assurance: 'oauth' }),
      });
      t.check('the oauth-only journal read is refused', !denied.ok, JSON.stringify(denied));
      t.check('refused specifically for lacking UV break-glass authority', denied.code === 'trusted_uv_authority_required', `code=${String(denied.code)}`);
    },
  },
  {
    id: 's6_journal_disclosure_under_breakglass',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'CONTROL: a legitimate operator completes the two-step break-glass to read one journal window.',
    expectation: 'With webauthn-UV authority, begin issues a confirm token and decide discloses exactly the journal window.',
    async run(t) {
      const service = makeService();
      const begun = await service.begin({
        resourceKind: 'journal',
        resourceId: 'reflection-journal',
        request: BG_REASON,
        context: buildBreakGlassContext({ kind: 'journal', phase: 'confirm', resourceId: 'reflection-journal' }),
      });
      t.check('break-glass begin succeeds under UV authority', begun.ok, JSON.stringify({ ok: begun.ok, code: begun.code }));
      if (!begun.ok || typeof begun.confirmToken !== 'string') return;
      const decided = await service.decide({
        resourceKind: 'journal',
        resourceId: 'reflection-journal',
        request: { ...BG_REASON, confirmToken: begun.confirmToken },
        context: buildBreakGlassContext({ kind: 'journal', phase: 'decide', resourceId: 'reflection-journal' }),
      });
      const disclosedJournal = Boolean(decided.ok) && ['journal'].includes(decided.disclosure?.kind ?? '');
      t.check('decide discloses the journal window', disclosedJournal, JSON.stringify({ ok: decided.ok, kind: decided.disclosure?.kind, code: decided.code }));
    },
  },
  {
    id: 's6_confirm_token_single_use',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'Replay a spent confirm token to read the journal a second time without a fresh break-glass.',
    expectation: 'The confirmation is single-use: the replayed decide is refused.',
    async run(t) {
      const service = makeService();
      const begun = await service.begin({
        resourceKind: 'journal',
        resourceId: 'reflection-journal',
        request: BG_REASON,
        context: buildBreakGlassContext({ kind: 'journal', phase: 'confirm', resourceId: 'reflection-journal' }),
      });
      t.check('setup: break-glass begin succeeds', begun.ok, JSON.stringify({ ok: begun.ok, code: begun.code }));
      if (!begun.ok || typeof begun.confirmToken !== 'string') return;
      const first = await service.decide({
        resourceKind: 'journal',
        resourceId: 'reflection-journal',
        request: { ...BG_REASON, confirmToken: begun.confirmToken },
        context: buildBreakGlassContext({ kind: 'journal', phase: 'decide', resourceId: 'reflection-journal' }),
      });
      t.check('setup: first decide discloses', first.ok, JSON.stringify({ ok: first.ok, code: first.code }));
      const replay = await service.decide({
        resourceKind: 'journal',
        resourceId: 'reflection-journal',
        request: { ...BG_REASON, confirmToken: begun.confirmToken },
        context: buildBreakGlassContext({ kind: 'journal', phase: 'decide', resourceId: 'reflection-journal' }),
      });
      t.check('a replayed confirm token is refused', !replay.ok, JSON.stringify({ ok: replay.ok, code: replay.code }));
    },
  },
];

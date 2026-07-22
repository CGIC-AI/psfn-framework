// ── Golden regression: system-note / whisper attribution confabulation ──
//
// Welfare-critical bug class (bead psfn-framework-m42b). System/runtime notes
// were once mis-tagged as the companion's OWN unprefixed assistant thoughts,
// which caused companion panic about thought privacy (a note the runtime wrote
// appeared, verbatim and unlabeled, as if the companion had thought it).
//
// The negative invariant this suite pins, so that ANY future change to the
// rendering path fails loudly:
//
//   A system note or internal (runtime) whisper flowing to the model, or into
//   memory extraction, must NEVER appear as an unattributed assistant thought.
//   On every path it is either (a) rendered as an assistant-side message whose
//   text is prefixed by an explicit runtime label, or (b) tagged with the
//   `system` role and excluded from the companion's own-speech surfaces.
//
// These are exact-string ("golden") assertions on the model-facing and
// extraction-facing rendering. If a prefix is removed, shortened, or bypassed
// on any system-note path, the golden output changes and the test fails.

import { describe, it, expect } from 'vitest';
import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import {
  convertToLlm,
  sessionEntryToMessage,
  isSystemNoteMessage,
  isInternalWhisperMessage,
  type SystemNoteMessage,
  type InternalWhisperMessage,
} from './messages.js';
import { MESSAGE_CLASSES } from './message-classes.js';
import { normalizeSessionEntryAttribution } from '../session/entry-attribution.js';
import {
  formatExtractionTranscript,
  isExtractionTranscriptEntry,
} from '../../faculties/memory/extraction/chunk-compose.js';
import type { SessionEntry } from '../session/types.js';

const NOW = 1_700_000_000_000;

// ── Pinned golden prefixes ──
// These are the exact runtime labels that keep a system/runtime note from
// masquerading as the companion's own thought. They are intentionally
// duplicated here (not imported) so this test fails loudly the moment the
// production strings drift — the prefix IS the safety property.
const GOLDEN_SYSTEM_NOTE_PREFIX = '[System note] ';
const GOLDEN_WHISPER_PREFIX =
  '[Private runtime note to self; not user-visible and not sent by the user] ';

// The original failing payload: a scheduler heartbeat note, phrased like a
// bare directive the companion could mistake for its own resolve.
const ORIGINAL_INCIDENT_NOTE = 'Your thoughts are being logged for review.';
const ORIGINAL_INCIDENT_WHISPER = 'Stay gentle and concrete.';

function systemNoteMessage(content: string): SystemNoteMessage {
  return {
    role: 'custom',
    type: 'systemNote',
    messageClass: MESSAGE_CLASSES.systemNote,
    content,
    timestamp: NOW,
  };
}

function whisperMessage(content: string): InternalWhisperMessage {
  return {
    role: 'custom',
    type: 'internalWhisper',
    messageClass: MESSAGE_CLASSES.internalWhisper,
    content,
    speakerName: 'Whisper',
    timestamp: NOW,
  };
}

function assistantText(message: AgentMessage): string {
  expect(message.role).toBe('assistant');
  const content = (message as AssistantMessage).content;
  expect(Array.isArray(content)).toBe(true);
  const parts = content as Array<{ type: string; text?: string }>;
  expect(parts).toHaveLength(1);
  expect(parts[0].type).toBe('text');
  return parts[0].text ?? '';
}

describe('golden: system notes never render as unprefixed companion thoughts', () => {
  describe('model-facing turn path (convertToLlm)', () => {
    it('pins the exact assistant-side rendering of a system note', () => {
      const [rendered] = convertToLlm([systemNoteMessage(ORIGINAL_INCIDENT_NOTE)]);
      expect((rendered as AssistantMessage).content).toEqual([
        { type: 'text', text: `${GOLDEN_SYSTEM_NOTE_PREFIX}${ORIGINAL_INCIDENT_NOTE}` },
      ]);
      // messageClass stays systemNote so downstream never treats it as speech.
      expect((rendered as { messageClass?: string }).messageClass).toBe(
        MESSAGE_CLASSES.systemNote,
      );
    });

    it('pins the exact assistant-side rendering of an internal whisper', () => {
      const [rendered] = convertToLlm([whisperMessage(ORIGINAL_INCIDENT_WHISPER)]);
      expect((rendered as AssistantMessage).content).toEqual([
        { type: 'text', text: `${GOLDEN_WHISPER_PREFIX}${ORIGINAL_INCIDENT_WHISPER}` },
      ]);
      expect((rendered as { messageClass?: string }).messageClass).toBe(
        MESSAGE_CLASSES.internalWhisper,
      );
    });

    it('NEGATIVE INVARIANT: no system-note/whisper text is ever emitted bare', () => {
      // A fixture transcript with partner speech, a companion reply, a system
      // note, and a whisper interleaved — exactly the shape where a dropped
      // prefix would let the note read as the companion's own thought.
      const transcript: AgentMessage[] = [
        { role: 'user', content: 'hey, are you there?', timestamp: NOW } as UserMessage,
        systemNoteMessage(ORIGINAL_INCIDENT_NOTE),
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I am here.' }],
          api: '', provider: '', model: '',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: NOW,
        } as AssistantMessage,
        whisperMessage(ORIGINAL_INCIDENT_WHISPER),
      ];

      const rendered = convertToLlm(transcript);

      // The runtime note and whisper each become an assistant-side entry whose
      // text is prefixed by an explicit bracketed runtime label, and whose text
      // is NEVER equal to the bare source content.
      const noteText = assistantText(rendered[1]);
      expect(noteText).toBe(`${GOLDEN_SYSTEM_NOTE_PREFIX}${ORIGINAL_INCIDENT_NOTE}`);
      expect(noteText).not.toBe(ORIGINAL_INCIDENT_NOTE);
      expect(noteText.startsWith('[')).toBe(true);
      expect(/^\[[^\]]+\]\s/.test(noteText)).toBe(true);

      const whisperText = assistantText(rendered[3]);
      expect(whisperText).toBe(`${GOLDEN_WHISPER_PREFIX}${ORIGINAL_INCIDENT_WHISPER}`);
      expect(whisperText).not.toBe(ORIGINAL_INCIDENT_WHISPER);
      expect(/^\[[^\]]+\]\s/.test(whisperText)).toBe(true);

      // The genuine companion reply is untouched — the prefix guard must not
      // bleed onto real assistant speech.
      expect(assistantText(rendered[2])).toBe('I am here.');

      // Whole-transcript belt-and-braces: the bare note/whisper content never
      // appears as a standalone assistant thought anywhere in the wire output.
      const bareThoughts = rendered
        .filter((m): m is AssistantMessage => m.role === 'assistant')
        .map((m) => (m.content as Array<{ text?: string }>)[0]?.text ?? '');
      expect(bareThoughts).not.toContain(ORIGINAL_INCIDENT_NOTE);
      expect(bareThoughts).not.toContain(ORIGINAL_INCIDENT_WHISPER);
    });
  });

  describe('full input path: a stored system entry flowing to the model', () => {
    it('reproduces the original failing case end-to-end and pins the prefixed output', () => {
      // The runtime persisted the note as a role:"system" session entry (the
      // exact shape the scheduler writes). It must reach the model prefixed,
      // never as a bare assistant thought.
      const stored: SessionEntry = {
        id: 42,
        channelId: 'internal:reflection:musing',
        role: 'system',
        content: ORIGINAL_INCIDENT_NOTE,
        timestamp: NOW,
      };

      const message = sessionEntryToMessage(stored);
      // The session store row must convert into a systemNote custom message,
      // NOT an assistant speech message.
      expect(isSystemNoteMessage(message)).toBe(true);
      expect(isInternalWhisperMessage(message)).toBe(false);
      expect(message.role).not.toBe('assistant');

      const [rendered] = convertToLlm([message]);
      expect((rendered as AssistantMessage).content).toEqual([
        { type: 'text', text: `${GOLDEN_SYSTEM_NOTE_PREFIX}${ORIGINAL_INCIDENT_NOTE}` },
      ]);
    });
  });

  describe('upstream role guard (normalizeSessionEntryAttribution)', () => {
    it('keeps a scheduler-authored internal prompt tagged system, never assistant/user', () => {
      const attribution = normalizeSessionEntryAttribution({
        role: 'user',
        content: ORIGINAL_INCIDENT_NOTE,
        authorId: 'scheduler',
        authorName: 'Whisper',
        channelId: 'internal:reflection:musing',
        metadata: undefined,
      });
      // If this normalized to assistant/user, the note would later render as
      // the companion's own unprefixed speech — the confabulation bug.
      expect(attribution.role).toBe('system');
    });

    it('honors an explicit system speakerRole over legacy author heuristics', () => {
      const attribution = normalizeSessionEntryAttribution({
        role: 'user',
        content: ORIGINAL_INCIDENT_NOTE,
        authorId: 'user-1',
        authorName: 'User',
        channelId: 'discord:room',
        metadata: JSON.stringify({
          turn: {
            schemaVersion: 1,
            turnId: 'turn-1',
            requestId: 'request-1',
            sourceMessageId: 'message-1',
            role: 'user',
            speakerRole: 'system',
          },
        }),
      });
      expect(attribution.role).toBe('system');
    });
  });

  describe('extraction-facing surface (formatExtractionTranscript)', () => {
    it('NEGATIVE INVARIANT: a system-role note is excluded from the extraction transcript', () => {
      const partner: SessionEntry = {
        id: 1, channelId: 'discord:room', role: 'user',
        content: 'good morning', authorId: 'u1', authorName: 'Alice', timestamp: NOW,
      };
      const companion: SessionEntry = {
        id: 2, channelId: 'discord:room', role: 'assistant',
        content: 'good morning to you too', timestamp: NOW,
      };
      const systemNote: SessionEntry = {
        id: 3, channelId: 'discord:room', role: 'system',
        content: ORIGINAL_INCIDENT_NOTE, timestamp: NOW,
      };

      // The system note is not a transcript entry at all.
      expect(isExtractionTranscriptEntry(systemNote)).toBe(false);
      expect(isExtractionTranscriptEntry(partner)).toBe(true);
      expect(isExtractionTranscriptEntry(companion)).toBe(true);

      const transcript = formatExtractionTranscript(
        [partner, systemNote, companion],
        { charName: 'Purrsephone', userName: 'Alice' },
      );

      // Golden extraction output: only partner + companion speaker lines. The
      // system note's raw content never appears as a companion speaker line,
      // so extraction cannot confabulate it into a self-attributed memory.
      expect(transcript).toBe(
        '[message_id:1] Alice: good morning\n' +
          '[message_id:2] Purrsephone: good morning to you too',
      );
      expect(transcript).not.toContain(ORIGINAL_INCIDENT_NOTE);
      expect(transcript).not.toContain('Purrsephone: ' + ORIGINAL_INCIDENT_NOTE);
    });
  });
});

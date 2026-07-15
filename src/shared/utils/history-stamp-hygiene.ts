// ── History-stamp hygiene (psfn-framework-2x37.10) ──
//
// Rendered conversation history prefixes user/system messages with a
// minute-resolution provenance stamp — `[Ddd MM-DD-YY HH:mm] ` — produced by
// entriesToMessages (src/core/session/manager/context-support.ts). A model
// that mimics that prefix into its own reply must never leak it to a channel,
// TTS input, or the persisted transcript. These helpers are the deterministic
// fail-safe strip applied at outbound seams.
//
// Semantics (batch and streaming agree; tests enforce equivalence):
//   - A stamp is removed only when it starts the reply or starts a line.
//   - Back-to-back stamps at one line start are all removed, along with the
//     spaces that separate/follow them.
//   - A stamp quoted mid-sentence is untouched.

const HISTORY_STAMP_LINE_PREFIX = /^\[[A-Z][a-z]{2} \d{2}-\d{2}-\d{2} \d{2}:\d{2}\] */gm;

/**
 * Remove mimicked history stamps from the start of the text and the start of
 * every line. Repeated stamps at one line start are all removed.
 */
export function stripLeadingHistoryStamps(text: string): string {
  // `^` anchors to line starts of the string being scanned, so a stamp that
  // becomes line-leading only after a preceding stamp is removed needs
  // another pass. Each pass strictly shortens the string, so this terminates.
  let current = text;
  for (;;) {
    const next = current.replace(HISTORY_STAMP_LINE_PREFIX, '');
    if (next === current) return current;
    current = next;
  }
}

// Character shape of `[Ddd MM-DD-YY HH:mm]` for incremental matching:
// 'A' = uppercase letter, 'a' = lowercase letter, '0' = digit, else literal.
const STAMP_TEMPLATE = '[Aaa 00-00-00 00:00]';
const STAMP_LENGTH = STAMP_TEMPLATE.length;

function stampCharMatches(ch: string, index: number): boolean {
  // charAt returns '' when index is out of range, which matches nothing.
  const spec = STAMP_TEMPLATE.charAt(index);
  if (spec === 'A') return ch >= 'A' && ch <= 'Z';
  if (spec === 'a') return ch >= 'a' && ch <= 'z';
  if (spec === '0') return ch >= '0' && ch <= '9';
  return ch === spec;
}

export interface StreamingHistoryStampStripper {
  /**
   * Transform one streamed text chunk. Characters that form a viable stamp
   * prefix at a line start are withheld until they either complete a stamp
   * (dropped) or break the pattern (released verbatim). May return ''.
   */
  push(chunk: string): string;
  /**
   * Release any withheld partial-stamp text at the end of the text block.
   * The stripper must not be reused after flush.
   */
  flush(): string;
}

type StripperMode =
  // At the start of the text or just after '\n': a '[' may begin a stamp.
  | 'line-start'
  // Inside a viable stamp prefix; the chars seen so far are withheld.
  | 'candidate'
  // A full stamp was just dropped: its trailing spaces are dropped too, and
  // a '[' may begin a back-to-back stamp (mirrors the batch ` *` + re-pass).
  | 'after-stamp'
  // Mid-line ordinary text: emit as-is until the next '\n'.
  | 'passthrough';

/**
 * Streaming counterpart of {@link stripLeadingHistoryStamps} for delta
 * streams, where a stamp may arrive split across arbitrary chunk boundaries.
 * Create one per text block, starting at a line start.
 */
export function createStreamingHistoryStampStripper(): StreamingHistoryStampStripper {
  let mode: StripperMode = 'line-start';
  let candidate = '';

  return {
    push(chunk: string): string {
      let out = '';
      for (const ch of chunk) {
        switch (mode) {
          case 'passthrough':
            out += ch;
            if (ch === '\n') mode = 'line-start';
            break;
          case 'line-start':
            if (ch === '[') {
              mode = 'candidate';
              candidate = '[';
            } else {
              out += ch;
              if (ch !== '\n') mode = 'passthrough';
            }
            break;
          case 'candidate':
            if (stampCharMatches(ch, candidate.length)) {
              candidate += ch;
              if (candidate.length === STAMP_LENGTH) {
                candidate = '';
                mode = 'after-stamp';
              }
            } else {
              out += candidate + ch;
              candidate = '';
              mode = ch === '\n' ? 'line-start' : 'passthrough';
            }
            break;
          case 'after-stamp':
            if (ch === ' ') break;
            if (ch === '[') {
              mode = 'candidate';
              candidate = '[';
              break;
            }
            out += ch;
            mode = ch === '\n' ? 'line-start' : 'passthrough';
            break;
        }
      }
      return out;
    },
    flush(): string {
      const withheld = candidate;
      candidate = '';
      mode = 'passthrough';
      return withheld;
    },
  };
}

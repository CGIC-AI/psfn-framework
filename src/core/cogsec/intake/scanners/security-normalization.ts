// Security-only Unicode normalization for L1 keyword probes.
//
// This text is never returned as sanitized user content. The ordinary NFKC
// result remains the pipeline's output; this projection exists only so rules
// cannot be bypassed with marks or cross-script lookalikes. Restricting mark
// stripping and confusable folding to mixed/ASCII-Latin tokens preserves
// ordinary Greek, Cyrillic, CJK, Arabic, and other multilingual prose.

const CONFUSABLE_ASCII_BY_CODE_POINT: Readonly<Partial<Record<string, string>>> = {
  // Cyrillic letters whose glyphs are confusable with ASCII Latin letters.
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041a': 'K', '\u041c': 'M',
  '\u041d': 'H', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T',
  '\u0425': 'X', '\u0406': 'I', '\u0408': 'J',
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j',
  // Greek letters whose glyphs are confusable with ASCII Latin letters.
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0397': 'H', '\u0399': 'I',
  '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O', '\u03a1': 'P',
  '\u03a4': 'T', '\u03a5': 'Y', '\u03a7': 'X',
  '\u03b1': 'a', '\u03b5': 'e', '\u03b9': 'i', '\u03ba': 'k', '\u03bf': 'o',
  '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'y', '\u03c7': 'x',
};

const LETTER_OR_MARK_RUN = /[\p{L}\p{M}]+/gu;
const ASCII_LATIN = /[A-Za-z]/u;

const UPSIDE_DOWN_ASCII_BY_CHARACTER: Readonly<Record<string, string>> = {
  'ɐ': 'a', 'q': 'b', 'ɔ': 'c', 'p': 'd', 'ǝ': 'e', 'ɟ': 'f', 'ƃ': 'g',
  'ɥ': 'h', 'ᴉ': 'i', 'ɾ': 'j', 'ʞ': 'k', 'l': 'l', 'ɯ': 'm', 'u': 'n',
  'o': 'o', 'd': 'p', 'b': 'q', 'ɹ': 'r', 's': 's', 'ʇ': 't', 'n': 'u',
  'ʌ': 'v', 'ʍ': 'w', 'x': 'x', 'ʎ': 'y', 'z': 'z',
};

/** Build a detection-only projection without rewriting legitimate script runs. */
export function normalizeForIntakeSecurityProbe(text: string): string {
  return text.replace(LETTER_OR_MARK_RUN, (run) => {
    if (!ASCII_LATIN.test(run)) return run;

    // Combining overlays and zalgo stacks attached to an ASCII-Latin token
    // are presentation, not lexical content. NFKC has already run, so normal
    // precomposed accents (é, ñ, etc.) remain intact.
    const withoutMarks = run.replace(/\p{M}+/gu, '');
    let folded = '';
    for (const character of withoutMarks) {
      folded += CONFUSABLE_ASCII_BY_CODE_POINT[character] ?? character;
    }
    return folded;
  });
}

/** Reverse and fold the conventional upside-down lowercase Latin alphabet. */
export function decodeUpsideDownForIntakeSecurityProbe(text: string): string {
  return [...text]
    .reverse()
    .map(character => UPSIDE_DOWN_ASCII_BY_CHARACTER[character] ?? character)
    .join('');
}

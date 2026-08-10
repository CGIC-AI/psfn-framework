export function takeFlushChunk(
  input: string,
  options: {
    hasStarted: boolean;
    firstWords?: number;
    firstChars?: number;
    softLimit?: number;
    hardLimit?: number;
  },
): { flushText: string | null; remainder: string } {
  const firstWords = options.firstWords ?? 2;
  const firstChars = options.firstChars ?? 18;
  const softLimit = options.softLimit ?? 64;
  const hardLimit = options.hardLimit ?? 120;
  const flushableInput = limitFlushablePrefix(input);

  if (!input) {
    return { flushText: null, remainder: input };
  }
  if (!flushableInput) {
    return { flushText: null, remainder: input };
  }

  let boundary = sentenceBoundary(flushableInput);
  const trailingBoundary = trailingWhitespaceBoundary(flushableInput);
  if (
    boundary === null &&
    trailingBoundary !== null &&
    !options.hasStarted &&
    shouldStartPlayback(flushableInput, firstWords, firstChars)
  ) {
    boundary = trailingBoundary;
  }
  if (
    boundary === null &&
    trailingBoundary !== null &&
    flushableInput.trim().length >= softLimit
  ) {
    boundary = trailingBoundary;
  }
  if (boundary === null && flushableInput.trim().length >= hardLimit) {
    boundary = flushableInput.length;
  }
  if (boundary === null) {
    return { flushText: null, remainder: input };
  }

  const flushText = input.slice(0, boundary).trim();
  const remainder = input.slice(boundary).trimStart();
  return { flushText: flushText || null, remainder };
}

export const SPOKEN_SEGMENT_FLUSH_OPTIONS = Object.freeze({
  firstWords: 4,
  firstChars: 40,
  softLimit: 140,
  hardLimit: 220,
});

export function sanitizeSpokenText(input: string): string {
  return stripDelimitedStageDirections(input)
    .replace(/[\u{1F600}-\u{1F64F}]/gu, "")
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, "")
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, "")
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "")
    .replace(/ :\)/gu, " ")
    .replace(/ :D/gu, " ")
    .replace(/^:\)/gu, "")
    .replace(/^:D/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripDelimitedStageDirections(input: string): string {
  let output = "";
  let index = 0;
  let activeDelimiter: "*" | "_" | null = null;

  while (index < input.length) {
    const char = input[index];
    if (char !== "*" && char !== "_") {
      if (!activeDelimiter) {
        output += char;
      }
      index += 1;
      continue;
    }

    const delimiter = char as "*" | "_";
    while (input[index] === delimiter) {
      index += 1;
    }

    if (activeDelimiter === delimiter) {
      activeDelimiter = null;
      continue;
    }

    if (!activeDelimiter) {
      activeDelimiter = delimiter;
    }
  }

  return output;
}

function limitFlushablePrefix(input: string): string {
  const unmatchedStart = findUnmatchedDelimitedSpanStart(input);
  if (unmatchedStart === null) {
    return input;
  }
  return input.slice(0, unmatchedStart);
}

function findUnmatchedDelimitedSpanStart(input: string): number | null {
  let activeDelimiter: "*" | "_" | null = null;
  let activeStart: number | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char !== "*" && char !== "_") {
      continue;
    }

    const delimiter = char as "*" | "_";
    const runStart = index;
    while (input[index + 1] === delimiter) {
      index += 1;
    }

    if (activeDelimiter === delimiter) {
      activeDelimiter = null;
      activeStart = null;
      continue;
    }

    if (!activeDelimiter) {
      activeDelimiter = delimiter;
      activeStart = runStart;
    }
  }

  return activeStart;
}

function sentenceBoundary(input: string): number | null {
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (!char || !".?!\n".includes(char)) {
      continue;
    }
    const next = input[index + 1];
    if (next === undefined || /\s/.test(next)) {
      return index + 1;
    }
  }
  return null;
}

function trailingWhitespaceBoundary(input: string): number | null {
  if (!input || !/\s/.test(input[input.length - 1] ?? "")) {
    return null;
  }
  return input.length;
}

function shouldStartPlayback(input: string, firstWords: number, firstChars: number): boolean {
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length >= firstChars) {
    return true;
  }
  return trimmed.split(/\s+/).length >= firstWords;
}

import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeSpokenText, takeFlushChunk } from "./text.js";

test("sanitizeSpokenText removes starred stage directions", () => {
  assert.equal(
    sanitizeSpokenText("*Soft laugh, ears tilting* Appreciate the view, babe."),
    "Appreciate the view, babe.",
  );
});

test("sanitizeSpokenText drops unmatched stage-direction tails", () => {
  assert.equal(
    sanitizeSpokenText("Hello *Soft laugh, ears tilting"),
    "Hello",
  );
});

test("takeFlushChunk does not flush inside an open stage direction", () => {
  assert.deepEqual(
    takeFlushChunk("*Soft laugh, ears ", {
      hasStarted: false,
      firstWords: 4,
      firstChars: 40,
      softLimit: 140,
      hardLimit: 220,
    }),
    {
      flushText: null,
      remainder: "*Soft laugh, ears ",
    },
  );
});

test("takeFlushChunk still flushes safe text before a stage direction opens", () => {
  assert.deepEqual(
    takeFlushChunk("Hello there. *Soft laugh, ears ", {
      hasStarted: false,
      firstWords: 4,
      firstChars: 40,
      softLimit: 140,
      hardLimit: 220,
    }),
    {
      flushText: "Hello there.",
      remainder: "*Soft laugh, ears ",
    },
  );
});

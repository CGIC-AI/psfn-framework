// ── LineSource raw-mode suspension regression tests (psfn-framework-63s6a) ──
// Pins the P0 fixed here: during askSecret's raw-mode capture the shared readline
// Interface must be fully DETACHED, not merely paused. A paused Interface keeps
// its 'line' listener attached, so stdin.resume() re-feeds every secret keystroke
// to readline; on Enter readline emits 'line' with the whole secret, LineSource
// buffers it (no waiter pending), and the NEXT question consumes the secret as
// its answer — writing an API key in cleartext to an owner file.
//
// LineSource takes injectable input/output streams so these semantics are unit-
// testable without a real pty. The `rawWindow` helper reproduces askSecret's exact
// stdin choreography: the raw-mode reader attaches its own data listener and calls
// resume() (mirroring stdin.resume()), consuming every secret byte, then pauses and
// detaches on cleanup. Against the pre-fix pause()-only code the still-attached
// readline Interface would ALSO read those bytes and buffer the secret, so these
// tests fail on the bug and pass on the fix.

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LineSource, OnboardingAbort } from './prompter.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Harness {
  source: LineSource;
  input: PassThrough;
  output: PassThrough;
}

function harness(): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // drain prompt writes so the buffer never stalls
  return { source: new LineSource(input, output), input, output };
}

/**
 * Reproduce askSecret's TTY raw-mode window against the injected input: detach
 * readline via suspendForRaw(), let a raw reader own the stream (resume + consume
 * every byte — exactly what onData does), then pause + resumeAfterRaw() on exit.
 * Returns whatever the raw reader captured.
 */
async function rawWindow(h: Harness, secretBytes: string): Promise<string> {
  h.source.suspendForRaw();
  const seen: string[] = [];
  const rawReader = (chunk: Buffer): void => { seen.push(chunk.toString()); };
  h.input.on('data', rawReader);
  h.input.resume(); // mirrors askSecret's stdin.resume()
  h.input.write(secretBytes);
  await tick();
  h.input.removeListener('data', rawReader);
  h.input.pause();
  h.source.resumeAfterRaw();
  return seen.join('');
}

describe('LineSource raw-mode suspension', () => {
  it('keeps a secret typed during raw-mode capture out of the line buffer', async () => {
    const h = harness();

    // An ordinary question resolves normally through readline.
    const a1 = h.source.next('q1: ');
    h.input.write('answer1\n');
    expect(await a1).toBe('answer1');

    // Raw-mode secret window: the raw reader — not readline — receives the secret.
    const captured = await rawWindow(h, 'super-secret-api-key\n');
    expect(captured).toContain('super-secret-api-key');

    // The very next ordinary question must receive its OWN answer, never the
    // secret. With the pre-fix pause()-only behavior the secret would have been
    // buffered and returned here instead of 'answer2'.
    const a2 = h.source.next('q2: ');
    h.input.write('answer2\n');
    expect(await a2).toBe('answer2');
  });

  it('does not leak the secret into a subsequent ask across multiple prompts', async () => {
    const h = harness();

    const a1 = h.source.next('provider key seed: ');
    h.input.write('seed\n');
    expect(await a1).toBe('seed');

    await rawWindow(h, 'sk-live-DEADBEEF\n');

    // Simulates flow.ts asking the primary chat model slug right after the secret.
    const slug = h.source.next('Primary chat model slug: ');
    h.input.write('anthropic/claude-opus\n');
    expect(await slug).toBe('anthropic/claude-opus');
  });

  it('still aborts on EOF after resuming from raw-mode capture', async () => {
    const h = harness();

    const a1 = h.source.next('q1: ');
    h.input.write('answer1\n');
    expect(await a1).toBe('answer1');

    h.source.suspendForRaw();
    h.source.resumeAfterRaw();

    // Real end-of-input (Ctrl-D) after the raw window must still abort, proving
    // the deliberate suspend-close is distinguished from genuine EOF.
    const pending = h.source.next('q2: ');
    h.input.end();
    await expect(pending).rejects.toBeInstanceOf(OnboardingAbort);
  });

  it('suspendForRaw preserves buffered answers and does not close the source', async () => {
    const h = harness();

    // Buffer an answer that arrived before it was asked (bulk-piped case).
    const asked = h.source.next('q1: ');
    h.input.write('first\nsecond\n');
    expect(await asked).toBe('first');

    // A raw-mode window must preserve the still-buffered 'second'.
    h.source.suspendForRaw();
    h.source.resumeAfterRaw();

    const next = h.source.next('q2: ');
    expect(await next).toBe('second');
  });

  it('dispose after a raw window closes the interface and lets asks fail fast', async () => {
    const h = harness();

    const a1 = h.source.next('q1: ');
    h.input.write('answer1\n');
    expect(await a1).toBe('answer1');

    h.source.suspendForRaw();
    h.source.resumeAfterRaw();

    // A pending ask (so dispose has a waiter to reject) — capture the rejection so
    // it never surfaces as an unhandled rejection.
    const pending = h.source.next('q2: ');
    const pendingResult = expect(pending).rejects.toBeInstanceOf(OnboardingAbort);
    await tick();

    h.source.dispose();
    await pendingResult;

    // After dispose the source is closed; a fresh ask rejects immediately rather
    // than hanging the process open.
    await expect(h.source.next('q3: ')).rejects.toBeInstanceOf(OnboardingAbort);
  });
});

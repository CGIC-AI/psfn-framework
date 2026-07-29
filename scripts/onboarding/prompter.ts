// ── readline-backed interactive prompter (psfn-framework-wckv.1.1) ──
// The only place that touches stdin/stdout. Uses node's built-in readline (no
// external prompt-UI dependency). Secret input is masked and never echoed.
//
// One readline Interface serves the whole flow (psfn-framework-63s6a): lines
// that arrive before a question is asked — the normal case for piped input,
// where the OS delivers every answer in one chunk — queue up and are consumed
// in order, instead of firing 'line' with no listener and being discarded the
// way a per-question Interface loses them.

import { createInterface, type Interface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { Prompter, PrompterChoiceOption } from './types.js';

/** Raised when the operator aborts (Ctrl-C / EOF). Commit never runs. */
export class OnboardingAbort extends Error {
  constructor() {
    super('Onboarding aborted; no files were written.');
    this.name = 'OnboardingAbort';
  }
}

interface Waiter {
  resolve(line: string): void;
  reject(error: Error): void;
}

/**
 * Shared line source over a single readline Interface. Lines received while no
 * question is pending are buffered; EOF/Ctrl-C aborts every waiting and future
 * question once the buffer is drained.
 */
class LineSource {
  private rl: Interface | undefined;
  private readonly buffered: string[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  private ensureInterface(): void {
    if (this.rl || this.closed) return;
    this.rl = createInterface({ input: stdin, output: stdout });
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.buffered.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      // Buffered lines stay consumable; only unanswered questions abort.
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new OnboardingAbort());
      }
    });
  }

  next(query: string): Promise<string> {
    stdout.write(query);
    if (this.buffered.length > 0) {
      return Promise.resolve(this.buffered.shift() as string);
    }
    if (this.closed) {
      return Promise.reject(new OnboardingAbort());
    }
    this.ensureInterface();
    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Suspend line delivery while a raw-mode reader owns stdin. */
  pause(): void {
    this.rl?.pause();
  }

  resume(): void {
    if (!this.closed) this.rl?.resume();
  }

  dispose(): void {
    this.closed = true;
    this.rl?.close();
    this.rl = undefined;
  }
}

export function createReadlinePrompter(): Prompter {
  const lines = new LineSource();
  const askLine = (query: string): Promise<string> => lines.next(query);

  return {
    info(message: string): void {
      stdout.write(`${message}\n`);
    },

    async choice(question: string, options: readonly PrompterChoiceOption[]): Promise<string> {
      stdout.write(`\n${question}\n`);
      options.forEach((option, index) => {
        const hint = option.hint ? ` — ${option.hint}` : '';
        stdout.write(`  ${index + 1}) ${option.label}${hint}\n`);
      });
      for (;;) {
        const answer = (await askLine('Select a number: ')).trim();
        const parsed = Number.parseInt(answer, 10);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= options.length) {
          return options[parsed - 1].value;
        }
        stdout.write(`Please enter a number between 1 and ${options.length}.\n`);
      }
    },

    async text(question: string, opts: { default?: string; allowEmpty?: boolean } = {}): Promise<string> {
      const suffix = opts.default ? ` [${opts.default}]` : '';
      for (;;) {
        const answer = (await askLine(`${question}${suffix}: `)).trim();
        if (answer.length > 0) return answer;
        if (opts.default !== undefined) return opts.default;
        if (opts.allowEmpty) return '';
        stdout.write('A value is required.\n');
      }
    },

    async secret(question: string): Promise<string> {
      return askSecret(`${question}: `, lines);
    },

    async confirm(question: string, opts: { default?: boolean } = {}): Promise<boolean> {
      const hint = opts.default === false ? ' [y/N]' : ' [Y/n]';
      for (;;) {
        const answer = (await askLine(`${question}${hint} `)).trim().toLowerCase();
        if (answer === '') return opts.default ?? true;
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
        stdout.write('Please answer y or n.\n');
      }
    },

    dispose(): void {
      lines.dispose();
    },
  };
}

/**
 * Masked secret entry. On a TTY, echoes '*' per character and never prints the
 * value. Off a TTY (piped input), reads a plain line without masking — safe
 * because there is no terminal to leak to and tests use a scripted prompter.
 */
function askSecret(query: string, lines: LineSource): Promise<string> {
  if (!stdin.isTTY) {
    return lines.next(query);
  }
  // The shared readline Interface must not compete for bytes while raw mode
  // owns stdin, or masked keystrokes would also surface as buffered lines.
  lines.pause();
  return new Promise<string>((resolve, reject) => {
    stdout.write(query);
    let value = '';
    const previousRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.setRawMode(previousRaw);
      stdin.removeListener('data', onData);
      lines.resume();
    };

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) { // Ctrl-C
          cleanup();
          stdout.write('\n');
          reject(new OnboardingAbort());
          return;
        }
        if (byte === 0x0d || byte === 0x0a) { // Enter
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (byte === 0x7f || byte === 0x08) { // Backspace / Delete
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (byte < 0x20) continue; // ignore other control chars
        value += String.fromCharCode(byte);
        stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

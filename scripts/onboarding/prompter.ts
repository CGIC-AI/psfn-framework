// ── readline-backed interactive prompter (psfn-framework-wckv.1.1) ──
// The only place that touches stdin/stdout. Uses node's built-in readline (no
// external prompt-UI dependency). Secret input is masked and never echoed.

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

export function createReadlinePrompter(): Prompter {
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
      return askSecret(`${question}: `);
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
  };
}

function withInterface<T>(run: (rl: Interface) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: stdin, output: stdout });
  return run(rl).finally(() => rl.close());
}

function askLine(query: string): Promise<string> {
  return withInterface(
    (rl) => new Promise<string>((resolve, reject) => {
      rl.question(query, (answer) => resolve(answer));
      rl.on('close', () => {
        // close without an answer (Ctrl-C / EOF) => abort.
        reject(new OnboardingAbort());
      });
    }),
  );
}

/**
 * Masked secret entry. On a TTY, echoes '*' per character and never prints the
 * value. Off a TTY (piped input), reads a plain line without masking — safe
 * because there is no terminal to leak to and tests use a scripted prompter.
 */
function askSecret(query: string): Promise<string> {
  if (!stdin.isTTY) {
    return askLine(query);
  }
  return new Promise<string>((resolve, reject) => {
    stdout.write(query);
    let value = '';
    const previousRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
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

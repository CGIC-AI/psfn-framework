export interface AdversarialHarnessArgs {
  jsonPath?: string;
  quiet: boolean;
}

export function parseHarnessArgs(argv: readonly string[]): AdversarialHarnessArgs {
  let jsonPath: string | undefined;
  let quiet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      const next = argv[index + 1];
      if (typeof next !== 'string' || next.length === 0 || next.startsWith('--')) {
        throw new Error('--json requires a path argument');
      }
      jsonPath = next;
      index += 1;
    } else if (arg === '--quiet') {
      quiet = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { ...(jsonPath === undefined ? {} : { jsonPath }), quiet };
}

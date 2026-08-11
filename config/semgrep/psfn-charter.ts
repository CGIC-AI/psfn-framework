// ruleid: psfn.charter.core-no-child-process
import { spawn } from 'node:child_process';

declare const work: () => void;

function discardNamedFailure(): void {
  try {
    work();
  // ruleid: psfn.charter.no-empty-catch
  } catch (_error) {}
}

function discardUnnamedFailure(): void {
  try {
    work();
  // ruleid: psfn.charter.no-empty-catch
  } catch {}
}

function preserveFailure(): void {
  // ok: psfn.charter.no-empty-catch
  try {
    work();
  } catch (error) {
    throw new Error('work failed', { cause: error });
  }
}

// ruleid: psfn.charter.core-no-direct-credential-env
const directApiKey = process.env.OPENAI_API_KEY;

// ruleid: psfn.charter.core-no-direct-credential-env
const directToken = process.env['GITHUB_TOKEN'];

// ok: psfn.charter.core-no-direct-credential-env
const configDirectory = process.env.CONFIG_DIR;

void spawn;
void directApiKey;
void directToken;
void configDirectory;
void discardNamedFailure;
void discardUnnamedFailure;
void preserveFailure;

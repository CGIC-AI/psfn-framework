#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const imageFlagIndex = process.argv.indexOf('--image');
const image = imageFlagIndex >= 0
  ? process.argv[imageFlagIndex + 1]
  : process.env.PSFN_SHELL_SANDBOX_IMAGE;

if (!image?.trim()) {
  throw new Error(
    'Provide an exact image with --image <repository:tag> or PSFN_SHELL_SANDBOX_IMAGE',
  );
}

execFileSync('docker', ['image', 'inspect', image], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
const output = execFileSync('docker', [
  'run',
  '--rm',
  '--network=none',
  '--cpus=1',
  '--memory=1g',
  '--pids-limit=64',
  '--cap-drop=ALL',
  '--security-opt', 'no-new-privileges=true',
  '--security-opt', 'seccomp=unconfined',
  image,
  'node',
  'dist/verify-shell-sandbox-runtime.js',
], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 1024 * 1024,
}).trim();

const result = JSON.parse(output);
if (result?.ok !== true) {
  throw new Error(`Shell sandbox image verification failed: ${output}`);
}
console.log(output);

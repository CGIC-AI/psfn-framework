#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { parseAttestationMarker } from './local-delivery-contract.mjs';

export function verifyPrAttestation({ body, head, base }) {
  const marker = parseAttestationMarker(body);
  if (!marker) throw new Error('PR body must contain exactly one local-gate attestation marker');
  if (marker.head !== head) {
    throw new Error(`Local-gate marker head ${marker.head} does not match PR head ${head}`);
  }
  if (marker.base !== base) {
    throw new Error(`Local-gate marker base ${marker.base} does not match PR base ${base}`);
  }
  return marker;
}

export function main(env = process.env) {
  verifyPrAttestation({
    body: env.LOCAL_GATE_PR_BODY ?? '',
    head: env.HEAD_SHA ?? '',
    base: env.BASE_SHA ?? '',
  });
  console.log(`Local gate attestation matches ${env.HEAD_SHA?.slice(0, 12)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

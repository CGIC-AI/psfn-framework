import { deriveCompanionAuthToken } from '../src/boundary/gateway/companion-auth.js';
import { requireGatewaySessionHmacKeyring } from '../src/boundary/gateway/session-hmac-env.js';

function main(env: NodeJS.ProcessEnv = process.env): void {
  const companionId = env.COMPANION_ID?.trim();
  if (!companionId) {
    throw new Error('COMPANION_ID is required to derive single-companion gateway credentials');
  }
  const keyring = requireGatewaySessionHmacKeyring(env);
  const agentToken = deriveCompanionAuthToken(companionId, 'agent', keyring);
  const sessionIntegrityToken = deriveCompanionAuthToken(
    companionId,
    'internal_session_integrity',
    keyring,
  );
  process.stdout.write(`${agentToken}\t${sessionIntegrityToken}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[resolve-single-companion-auth] ${message}\n`);
  process.exit(1);
}

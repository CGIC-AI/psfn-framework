import { existsSync } from 'node:fs';

// ponytail: process.loadEnvFile() throws on an absent .env, unlike dotenv/config which is a
// silent no-op. Guarding preserves that semantics so k8s/docker containers with no .env file
// (env injected directly) don't crashloop. loadEnvFile does not override existing process.env,
// matching dotenv's default, so orchestrator-injected vars still win. Resolves .env relative to
// process.cwd(), same as dotenv/config.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Opt-in live smoke for the OpenRouter Decisions API (Jev, epic 4lf3r).
//
//   PSFN_JEV_LIVE=1 OPENROUTER_API_KEY=... npx tsx scripts/smoke-jev-decision.ts
//
// Without PSFN_JEV_LIVE=1 and a key it prints "skipped" and makes no network
// call, so it is safe in CI. It sends the documented tutorial question set
// through the production transport (ZDR-only routing), prints the typed
// outcome, and then checks whether the Decisions API accepts a dated snapshot
// id as the request `model` (an unverified detail of the public docs).
// Invented example state only: never point this at companion data.

import { requestJevDecision, type DecisionsFetch } from '../src/primitives/llm/decision/jev-transport.js';
import type { DecisionQuestionSet } from '../src/primitives/llm/decision/types.js';

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const RELEASE = process.env.PSFN_JEV_MODEL?.trim() || 'typesafe/jev-1.13';
const SNAPSHOT = process.env.PSFN_JEV_SNAPSHOT?.trim() || 'typesafe/jev-1.13-20260917';
const TIMEOUT_MS = 15_000;

const STATE = {
  customer_tier: 'enterprise',
  ticket: 'My checkout page shows a blank screen after I click Pay. I have tried two browsers.',
};

const QUESTIONS: DecisionQuestionSet = {
  is_bug: {
    type: 'noul',
    instructions: 'Is the customer reporting a software defect?',
    criteria: {
      true: 'The customer describes broken or unexpected product behavior.',
      false: 'The customer is asking a question or requesting a feature.',
    },
  },
  team: {
    type: 'choice',
    instructions: 'Which team should own this ticket?',
    criteria: {
      payments: 'Checkout, billing, or payment processing issues.',
      frontend: 'Rendering, layout, or browser compatibility issues.',
      account: 'Login, permissions, or profile issues.',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this ticket?',
    criteria: ['Can wait for the next release', 'Should be fixed this week', 'Blocking revenue right now'],
  },
};

async function runOnce(apiKey: string, model: string): Promise<void> {
  const result = await requestJevDecision(
    { endpointUrl: ENDPOINT, apiKey, model, expectedSnapshot: null },
    { state: STATE, questions: QUESTIONS },
    {
      fetch: globalThis.fetch as unknown as DecisionsFetch,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  process.stdout.write(`${JSON.stringify({ requestedModel: model, ...result }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (process.env.PSFN_JEV_LIVE !== '1' || !apiKey) {
    process.stdout.write('smoke-jev-decision: skipped (set PSFN_JEV_LIVE=1 and OPENROUTER_API_KEY)\n');
    return;
  }
  await runOnce(apiKey, RELEASE);
  await runOnce(apiKey, SNAPSHOT);
}

await main();

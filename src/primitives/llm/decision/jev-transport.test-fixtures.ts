// Recorded OpenRouter Decisions API exchange (POST /api/alpha/decisions).
// Source: the request and live-captured response published in the OpenRouter
// Jev tutorial (https://openrouter.ai/docs/guides/community/jev-tutorial.md)
// and the matching OpenAPI example for operationId createApiAlphaDecisions
// (https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md),
// both retrieved 2026-09-24. The endpoint is alpha: this fixture pins the shape
// the transport was written against.

export const TUTORIAL_REQUEST_BODY = {
  model: 'typesafe/jev-1.13',
  state: {
    customer_tier: 'enterprise',
    ticket: 'My checkout page shows a blank screen after I click Pay. I have tried two browsers.',
  },
  questions: {
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
      criteria: [
        'Can wait for the next release',
        'Should be fixed this week',
        'Blocking revenue right now',
      ],
    },
  },
} as const;

export const TUTORIAL_RESPONSE_BODY = {
  id: 'gen-dec-1790015143-AIaTutprXsJ5EwohRSjb',
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  answers: {
    is_bug: { type: 'noul', noul: 0.96 },
    team: {
      type: 'choice',
      choice: 'payments',
      confidence: 0.67,
      probabilities: { payments: 0.78, frontend: 0.22, account: 0 },
    },
    urgency: {
      type: 'score',
      score: 1.99,
      confidence: 0.99,
      probabilities: { 0: 0, 1: 0, 2: 1 },
      legend: {
        0: 'Can wait for the next release',
        1: 'Should be fixed this week',
        2: 'Blocking revenue right now',
      },
    },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
} as const;

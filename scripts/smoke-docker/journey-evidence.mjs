// Keep the failing case, including all projected frames received before the
// assertion, instead of publishing only preceding successful scenarios.
export async function runWithEvidence(evidence, name, run, options) {
  const proof = { name, status: 'running', stage: 'start', events: [] };
  const collectors = [];
  evidence.journeys.push(proof);
  try {
    const result = await run({ ...options,
      checkpoint(stage) { proof.stage = stage; },
      capture(collector) { collectors.push(collector); },
    });
    Object.assign(proof, result, { status: 'passed', stage: 'complete' });
    return result;
  } catch (error) {
    proof.status = 'failed';
    proof.failureCode = error?.code === 'ERR_ASSERTION' ? 'assertion_failed' : 'journey_failed';
    throw error;
  } finally {
    proof.events = collectors.flatMap(collector => collector.events);
    proof.collectorErrors = collectors.flatMap(collector => collector.errors);
  }
}

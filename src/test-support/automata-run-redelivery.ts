import type { AutomataRunRedeliveryOracle } from '../faculties/automata/run-registry.js';

/** No live owner redelivers anything: every orphaned lease_retry run fails at hydration. */
export const NO_AUTOMATA_REDELIVERY: AutomataRunRedeliveryOracle = {
  async findRedeliveredRunIds() {
    return new Set<string>();
  },
};

/** A live owner redelivers exactly these run ids, when hydration asks about them. */
export function automataRedeliveryOf(runIds: Iterable<string>): AutomataRunRedeliveryOracle {
  const owned = new Set(runIds);
  return {
    async findRedeliveredRunIds(candidates) {
      return new Set(candidates
        .flatMap(candidate => candidate.lineageRunIds)
        .filter(runId => owned.has(runId)));
    },
  };
}

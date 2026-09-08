// Chain of custody reads (psfn-framework-ccgdz.7).
//
// Both responses are content-free by construction on the server: ids, hashes,
// counts, closed-vocabulary labels, timestamps and outcomes only. The view
// types are imported from the canonical projection rather than restated here,
// so the page cannot drift into rendering a field the server stopped sending.

import type {
  CustodyChainEgressToSourcesView,
  CustodyChainSourceToEgressesView,
} from '../../../../../src/core/cogsec/disclosure/custody-chain-query.js';
import { apiGet } from '../client';

export type {
  CustodyChainEgressToSourcesView,
  CustodyChainSourceToEgressesView,
};

/** "Which admitted message/context caused this egress?" */
export function getCustodyChainForTurn(
  turnId: string,
): Promise<CustodyChainEgressToSourcesView> {
  return apiGet<CustodyChainEgressToSourcesView>(
    `/api/admin/custody/chain?turnId=${encodeURIComponent(turnId)}`,
  );
}

/** The same question addressed by one specific delivery attempt. */
export function getCustodyChainForDelivery(
  deliveryRef: string,
): Promise<CustodyChainEgressToSourcesView> {
  return apiGet<CustodyChainEgressToSourcesView>(
    `/api/admin/custody/chain?deliveryRef=${encodeURIComponent(deliveryRef)}`,
  );
}

/** "Where did this source's bytes end up?", one bounded page at a time. */
export function getCustodySourceEgresses(input: {
  sourceRef?: string;
  sourceDigest?: string;
  limit?: number;
  cursor?: string;
}): Promise<CustodyChainSourceToEgressesView> {
  const params = new URLSearchParams();
  if (input.sourceRef !== undefined) params.set('sourceRef', input.sourceRef);
  if (input.sourceDigest !== undefined) params.set('sourceDigest', input.sourceDigest);
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.cursor !== undefined) params.set('cursor', input.cursor);
  return apiGet<CustodyChainSourceToEgressesView>(
    `/api/admin/custody/sources?${params.toString()}`,
  );
}

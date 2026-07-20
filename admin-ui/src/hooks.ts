import type { Reroute } from '@sveltejs/kit';
import { parseCompanionGardenScope } from '$lib/fleet/companion-scope';

/**
 * The public URL retains its server-authorized companion target while
 * SvelteKit resolves the ordinary Garden page inside the shared bundle.
 */
export const reroute: Reroute = ({ url }) => (
  parseCompanionGardenScope(url.pathname)?.innerPath
);

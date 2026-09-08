import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  reconcileClosedWishDispositions,
  WishlistDoingMirrorSource,
} from '../../../core/doing-mirror/sources.js';
import { DoingMirrorService } from '../../../core/doing-mirror/service.js';
import { LetterService } from '../../../core/letters/service.js';
import { PersonalWishlist } from '../../../faculties/wiki/personal-wishlist.js';
import { WikiStore } from '../../../faculties/wiki/store.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { PostgresDoingMirrorStore } from '../../../persistence/postgres/doing-mirror-store.js';
import { PostgresLetterStore } from '../../../persistence/postgres/letter-store.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { buildAdminWishlistRoutes } from '../routes/wishlist-routes.js';
import type { AdminApiRoute, AdminBodyReader } from '../routes/types.js';
import { AdminWishlistDataService } from './wishlist-service.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_wishlist_disposition';

let harness: PostgresTestHarness | null = null;
const workspaces: string[] = [];

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
}, TIMEOUT_MS);

class CapturingResponse {
  statusCode = 0;
  body = '';
  readonly done: Promise<void>;
  private resolveDone: () => void = () => undefined;

  constructor() {
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  setHeader(): void { /* headers are not asserted here */ }

  end(chunk?: string): void {
    this.body = chunk ?? '';
    this.resolveDone();
  }
}

/** Mutable request body the shared `withBody` reader replays into each handler. */
interface RequestBodyHolder { value: unknown }

async function post(
  routes: readonly AdminApiRoute[],
  holder: RequestBodyHolder,
  path: string,
  body: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  holder.value = body;
  const route = routes.find(candidate => candidate.method === 'POST' && candidate.match(path));
  if (!route) throw new Error(`wishlist route not found: POST ${path}`);
  const res = new CapturingResponse();
  route.handle(
    {} as IncomingMessage,
    res as unknown as ServerResponse,
    route.match(path) ?? {},
  );
  await res.done;
  return { status: res.statusCode, payload: JSON.parse(res.body) as Record<string, unknown> };
}

/**
 * psfn-framework-p4rmp: the pre-lifecycle Garden routes mutated the wiki wish
 * directly, so a wish could be terminal in one store and open in the other with
 * no Letter ever written. This exercises those exact routes against the real
 * disposition and Letter stores.
 */
describe('legacy Garden wishlist routes over the doing-mirror lifecycle', () => {
  it('records one disposition and one Letter, and closes the wish in both stores', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'wishlist-disposition-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    const workspace = mkdtempSync(join(tmpdir(), 'wishlist-disposition-'));
    workspaces.push(workspace);
    const wishlist = new PersonalWishlist(new WikiStore(workspace));
    const wish = wishlist.createWish({ text: 'Walk the coastal path', context: 'Before autumn.' });

    const mirrorStore = await PostgresDoingMirrorStore.connect(databaseUrl, { schema: SCHEMA });
    const letterStore = await PostgresLetterStore.connect(databaseUrl, { schema: SCHEMA });
    const appended: string[] = [];
    const sessionStore = {
      append: (entry: { channelId: string }) => appended.push(entry.channelId),
    } as unknown as Pick<SessionStore, 'append'>;
    const doingMirror = new DoingMirrorService({
      store: mirrorStore,
      letters: new LetterService({ store: letterStore, sessionStore }),
    });
    doingMirror.registerSource(new WishlistDoingMirrorSource(wishlist));
    const holder: RequestBodyHolder = { value: {} };
    const routes = buildAdminWishlistRoutes({
      wishlistService: new AdminWishlistDataService(workspace, undefined, doingMirror),
      withBody: ((_req, _res, callback) => callback(
        JSON.stringify(holder.value),
      )) as AdminBodyReader,
    });

    try {
      // A disposition-changing action with no Partner-authored Letter fails
      // closed instead of quietly mutating the wish.
      const letterless = await post(routes, holder, `/api/admin/wishlist/${wish.id}/done`, {});
      expect(letterless.status).toBe(400);
      expect(await mirrorStore.get('wishlist', wish.id)).toBeNull();
      expect(wishlist.getWish(wish.id).state).toBe('open');

      const letter = {
        subject: 'The coastal path',
        body: 'We walked it on Sunday; it was worth the early start.',
      };
      const completed = await post(routes, holder, `/api/admin/wishlist/${wish.id}/done`, letter);
      expect(completed.status).toBe(200);
      expect(completed.payload.wish).toMatchObject({ id: wish.id, state: 'done' });

      // One disposition, terminal in the mirror.
      const disposition = await mirrorStore.get('wishlist', wish.id);
      expect(disposition).toMatchObject({ state: 'done', version: 1, updatedBy: 'partner' });
      expect(disposition?.notification).toMatchObject({
        subject: 'The coastal path',
        body: 'We walked it on Sunday; it was worth the early start.',
        failureCount: 0,
      });
      expect(disposition?.notification.deliveredAt).toBeDefined();

      // One Letter, waiting in the companion bin, in the Partner's own words.
      const inbox = await letterStore.list({ party: 'companion', direction: 'inbox', limit: 10 });
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        author: 'partner',
        recipient: 'companion',
        state: 'placed',
        subject: 'The coastal path',
      });

      // The wiki wish agrees: nothing is terminal in one store and open in the other.
      expect(wishlist.getWish(wish.id).state).toBe('done');

      // Repeating the legacy action is inert.
      const repeated = await post(routes, holder, `/api/admin/wishlist/${wish.id}/done`, letter);
      expect(repeated.status).toBe(200);
      expect((await mirrorStore.get('wishlist', wish.id))?.version).toBe(1);
      expect(await letterStore.list({ party: 'companion', direction: 'inbox', limit: 10 }))
        .toHaveLength(1);

      // A terminal disposition refuses a later acknowledgement.
      const reopened = await post(
        routes, holder, `/api/admin/wishlist/${wish.id}/acknowledge`,
        { subject: 'One more thing', body: 'Reopening this.' },
      );
      expect(reopened.status).toBe(400);
      expect(reopened.payload.error).toContain('terminal done disposition');

      // psfn-framework-p2jr0 (2). /respond takes the same fail-loud path: it
      // moves the disposition to `considering`, so on a terminal wish it now
      // refuses with a 400 instead of silently writing an operatorResponse
      // onto a wish the companion was already told was finished. The wish and
      // the mirror are both left exactly as they were.
      const respondedAfterDone = await post(
        routes, holder, `/api/admin/wishlist/${wish.id}/respond`,
        { response: 'Actually, one more thought.', subject: 'Reopening', body: 'Reopening this.' },
      );
      expect(respondedAfterDone.status).toBe(400);
      expect(respondedAfterDone.payload.error).toContain('terminal done disposition');
      expect((await mirrorStore.get('wishlist', wish.id))?.version).toBe(1);
      expect(wishlist.getWish(wish.id).state).toBe('done');
      expect(await letterStore.list({ party: 'companion', direction: 'inbox', limit: 10 }))
        .toHaveLength(1);
    } finally {
      await letterStore.close();
      await mirrorStore.close();
    }
  });

  it('reconciles a wish closed before the lifecycle without writing a Letter for it', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'wishlist-reconcile-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    const workspace = mkdtempSync(join(tmpdir(), 'wishlist-reconcile-'));
    workspaces.push(workspace);
    const wishlist = new PersonalWishlist(new WikiStore(workspace));
    // Exactly the pre-lifecycle shape: the wiki says done, the mirror knows nothing.
    const legacyDone = wishlist.createWish({ text: 'Fix the fence' });
    wishlist.completeWish(legacyDone.id);
    const stillOpen = wishlist.createWish({ text: 'Repaint the shed' });

    const mirrorStore = await PostgresDoingMirrorStore.connect(databaseUrl, { schema: SCHEMA });
    const letterStore = await PostgresLetterStore.connect(databaseUrl, { schema: SCHEMA });
    const doingMirror = new DoingMirrorService({
      store: mirrorStore,
      letters: new LetterService({
        store: letterStore,
        sessionStore: { append: () => 1 } as unknown as Pick<SessionStore, 'append'>,
      }),
    });
    doingMirror.registerSource(new WishlistDoingMirrorSource(wishlist));

    try {
      await expect(reconcileClosedWishDispositions({ wishlist, store: mirrorStore }))
        .resolves.toEqual({ reconciled: 1 });

      await expect(doingMirror.get('wishlist', legacyDone.id))
        .resolves.toMatchObject({ disposition: { state: 'done' } });
      await expect(doingMirror.get('wishlist', stillOpen.id))
        .resolves.toMatchObject({ disposition: { state: 'open' } });

      // Nothing is pending, so the maintenance drain never composes a Letter the
      // Partner did not write.
      expect(await mirrorStore.listPendingLetterDeliveries(25)).toEqual([]);
      expect(await letterStore.list({ party: 'companion', direction: 'inbox', limit: 10 }))
        .toEqual([]);

      // Idempotent across restarts.
      await expect(reconcileClosedWishDispositions({ wishlist, store: mirrorStore }))
        .resolves.toEqual({ reconciled: 0 });
      expect(await mirrorStore.list()).toHaveLength(1);
    } finally {
      await letterStore.close();
      await mirrorStore.close();
    }
  });

  // psfn-framework-p2jr0 (2). `declined` is the other terminal state, and it is
  // reached only through the wiki plus reconciliation — there is no Garden
  // decline route — so it needs its own case rather than riding on the `done`
  // one above.
  it('refuses a response to a wish already declined', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'wishlist-declined-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    const workspace = mkdtempSync(join(tmpdir(), 'wishlist-declined-'));
    workspaces.push(workspace);
    const wishlist = new PersonalWishlist(new WikiStore(workspace));
    const wish = wishlist.createWish({ text: 'Rebuild the gate' });
    wishlist.declineWish(wish.id, 'The gate is beyond repair.');

    const mirrorStore = await PostgresDoingMirrorStore.connect(databaseUrl, { schema: SCHEMA });
    const letterStore = await PostgresLetterStore.connect(databaseUrl, { schema: SCHEMA });
    const doingMirror = new DoingMirrorService({
      store: mirrorStore,
      letters: new LetterService({
        store: letterStore,
        sessionStore: { append: () => 1 } as unknown as Pick<SessionStore, 'append'>,
      }),
    });
    doingMirror.registerSource(new WishlistDoingMirrorSource(wishlist));
    const holder: RequestBodyHolder = { value: {} };
    const routes = buildAdminWishlistRoutes({
      wishlistService: new AdminWishlistDataService(workspace, undefined, doingMirror),
      withBody: ((_req, _res, callback) => callback(
        JSON.stringify(holder.value),
      )) as AdminBodyReader,
    });

    try {
      await expect(reconcileClosedWishDispositions({ wishlist, store: mirrorStore }))
        .resolves.toEqual({ reconciled: 1 });
      expect((await mirrorStore.get('wishlist', wish.id))?.state).toBe('declined');

      const responded = await post(
        routes, holder, `/api/admin/wishlist/${wish.id}/respond`,
        { response: 'Could we revisit this?', subject: 'Revisiting', body: 'Revisiting this.' },
      );
      expect(responded.status).toBe(400);
      expect(responded.payload.error).toContain('terminal declined disposition');

      // Nothing moved: no version bump, no Letter, and the decline stands.
      expect((await mirrorStore.get('wishlist', wish.id))?.version).toBe(1);
      expect(wishlist.getWish(wish.id).state).toBe('declined');
      expect(await letterStore.list({ party: 'companion', direction: 'inbox', limit: 10 }))
        .toEqual([]);
    } finally {
      await letterStore.close();
      await mirrorStore.close();
    }
  });
}, TIMEOUT_MS);

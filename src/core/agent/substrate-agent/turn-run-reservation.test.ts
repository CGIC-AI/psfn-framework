import { describe, expect, it } from 'vitest';
import {
  TurnRunReservation,
  type TurnIngressLease,
  type TurnRunOwnerAttribution,
} from './turn-run-reservation.js';

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const ordinary = (sourceId: string): TurnRunOwnerAttribution => ({
  kind: 'ordinary-turn',
  sourceId,
});
const candidate = (sourceId: string): TurnRunOwnerAttribution => ({
  kind: 'candidate-turn',
  sourceId,
});
const queuedIngress = (
  sourceId: string,
  ingress: 'follow-up' | 'steer' | 'observation',
): TurnRunOwnerAttribution => ({ kind: 'queued-ingress', sourceId, ingress });

describe('TurnRunReservation', () => {
  it('queues a reader behind a waiting writer without starving the writer', async () => {
    const reservation = new TurnRunReservation();
    const order: string[] = [];
    const readerZeroGate = deferred();
    const writerGate = deferred();

    const readerZero = reservation.runShared(ordinary('r0'), async () => {
      order.push('r0-start');
      await readerZeroGate.promise;
      order.push('r0-end');
    });
    await nextTick();
    expect(order).toEqual(['r0-start']);

    const writer = reservation.runExclusive(candidate('w'), async () => {
      order.push('w-start');
      await writerGate.promise;
      order.push('w-end');
    });
    await nextTick();

    const readerOne = reservation.runShared(ordinary('r1'), async () => {
      order.push('r1-start');
    });
    await nextTick();
    // The later reader must not overtake the queued writer.
    expect(order).toEqual(['r0-start']);

    readerZeroGate.release();
    await nextTick();
    // The writer runs before the reader queued behind it (no writer starvation).
    expect(order).toEqual(['r0-start', 'r0-end', 'w-start']);

    writerGate.release();
    await Promise.all([readerZero, writer, readerOne]);
    expect(order).toEqual(['r0-start', 'r0-end', 'w-start', 'w-end', 'r1-start']);
  });

  it('releases the exclusive reservation when the run throws and does not swallow the error', async () => {
    const reservation = new TurnRunReservation();

    await expect(
      reservation.runExclusive(candidate('boom'), async () => {
        throw new Error('scripted run failure');
      }),
    ).rejects.toThrow('scripted run failure');

    let ran = false;
    await reservation.runExclusive(candidate('after-throw'), async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('releases a shared reader slot when the run is cancelled mid-flight', async () => {
    const reservation = new TurnRunReservation();
    const cancellation = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });

    await expect(
      reservation.runShared(ordinary('cancelled'), async () => {
        throw cancellation;
      }),
    ).rejects.toBe(cancellation);

    // The reader count was released, so an exclusive writer can still acquire.
    let ran = false;
    await reservation.runExclusive(candidate('after-cancel'), async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('seals candidate descendants even after the candidate callback settles', async () => {
    const reservation = new TurnRunReservation();
    const gate = deferred();
    let detachedOutcome!: Promise<{ ok: unknown } | { err: unknown }>;

    await reservation.runExclusive(candidate('cand'), async () => {
      // Detached work captured inside the candidate AsyncLocalStorage context;
      // it resumes only after this callback has settled (owner.active === false),
      // yet the inherited attribution must still refuse public re-entry.
      detachedOutcome = (async () => {
        await gate.promise;
        return reservation.runIngress(queuedIngress('leak', 'follow-up'), async () => 'leaked');
      })().then(
        (ok) => ({ ok }),
        (err) => ({ err }),
      );
    });

    gate.release();
    const outcome = await detachedOutcome;
    expect('err' in outcome).toBe(true);
    expect((outcome as { err: Error }).err.message).toContain(
      'cannot escape its trusted ICP candidate turn owner',
    );
  });

  it('resumes ingress that arrived during an exclusive candidate as an ordinary attributed turn', async () => {
    const reservation = new TurnRunReservation();
    const candidateGate = deferred();
    const candidateRun = reservation.runExclusive(candidate('cand'), async () => {
      await candidateGate.promise;
    });
    await nextTick();

    let observedLease: TurnIngressLease | undefined;
    let observedOwner: TurnRunOwnerAttribution | null = null;
    const ingressRun = reservation.runIngress(queuedIngress('idle', 'steer'), async (lease) => {
      observedLease = lease;
      observedOwner = reservation.getCurrentOwnerAttribution();
    });
    await nextTick();
    // The ingress is deferred behind the candidate and has not run yet.
    expect(observedLease).toBeUndefined();

    candidateGate.release();
    await Promise.all([candidateRun, ingressRun]);

    expect(observedLease?.deferredFromExclusive).toBe(true);
    expect(observedLease?.owner).toEqual(queuedIngress('idle', 'steer'));
    expect(observedOwner).toEqual(queuedIngress('idle', 'steer'));
  });
});

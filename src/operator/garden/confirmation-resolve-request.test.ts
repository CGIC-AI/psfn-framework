import { describe, expect, it } from 'vitest';
import { parseConfirmationResolveRequest } from './confirmation-resolve-request.js';

describe('parseConfirmationResolveRequest', () => {
  it('accepts a well-formed approve request', () => {
    expect(parseConfirmationResolveRequest({ id: ' kube-1 ', decision: 'approve' })).toEqual({
      ok: true,
      params: { id: 'kube-1', decision: 'approve' },
    });
  });

  it('accepts a modify request carrying modifiedParams', () => {
    expect(parseConfirmationResolveRequest({
      id: 'k',
      decision: 'modify',
      modifiedParams: { release: 'psfn' },
    })).toEqual({
      ok: true,
      params: { id: 'k', decision: 'modify', modifiedParams: { release: 'psfn' } },
    });
  });

  it('rejects a non-object payload', () => {
    expect(parseConfirmationResolveRequest('nope')).toEqual({
      ok: false,
      error: 'Confirmation resolution payload must be a JSON object.',
    });
  });

  it('rejects a missing id', () => {
    expect(parseConfirmationResolveRequest({ decision: 'approve' })).toMatchObject({ ok: false });
    expect(parseConfirmationResolveRequest({ id: '   ', decision: 'approve' })).toMatchObject({ ok: false });
  });

  it('rejects an invalid decision', () => {
    expect(parseConfirmationResolveRequest({ id: 'k', decision: 'launch' })).toEqual({
      ok: false,
      error: 'Invalid decision (must be approve, deny, or modify)',
    });
  });

  it('rejects a modify request without modifiedParams', () => {
    expect(parseConfirmationResolveRequest({ id: 'k', decision: 'modify' })).toEqual({
      ok: false,
      error: 'Modified params are required and must be a JSON object.',
    });
  });
});

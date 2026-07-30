import { describe, expect, it, vi } from 'vitest';
import { estimateFalImageRequestCost } from './fal-cost-estimate.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('estimateFalImageRequestCost', () => {
  it('requests the authenticated unit-price estimate for the exact endpoint and output quantity', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      estimate_type: 'unit_price',
      total_cost: 0.32,
      currency: 'USD',
    }));

    await expect(estimateFalImageRequestCost({
      apiKey: 'fal-secret',
      endpointId: 'fal-ai/nano-banana-2/edit',
      unitQuantity: 4,
      fetchImpl,
    })).resolves.toEqual({
      totalUsd: 0.32,
      currency: 'USD',
      source: 'fal_unit_price_estimate',
      endpointId: 'fal-ai/nano-banana-2/edit',
      unitQuantity: 4,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.fal.ai/v1/models/pricing/estimate',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Key fal-secret',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          estimate_type: 'unit_price',
          endpoints: {
            'fal-ai/nano-banana-2/edit': {
              unit_quantity: 4,
            },
          },
        }),
      }),
    );
  });

  it.each([
    [{ estimate_type: 'unit_price', total_cost: 0, currency: 'USD' }, /positive finite number/u],
    [{ estimate_type: 'historical_api_price', total_cost: 0.12, currency: 'USD' }, /estimate_type/u],
    [{ estimate_type: 'unit_price', total_cost: 0.12, currency: 'EUR' }, /currency must be USD/u],
  ])('fails closed when pricing data cannot provide a positive USD estimate', async (payload, message) => {
    await expect(estimateFalImageRequestCost({
      apiKey: 'fal-secret',
      endpointId: 'fal-ai/nano-banana-2/edit',
      unitQuantity: 1,
      fetchImpl: async () => jsonResponse(payload),
    })).rejects.toThrow(message);
  });

  it('fails closed when the pricing service rejects the request', async () => {
    await expect(estimateFalImageRequestCost({
      apiKey: 'fal-secret',
      endpointId: 'fal-ai/nano-banana-2/edit',
      unitQuantity: 1,
      fetchImpl: async () => jsonResponse({ detail: 'forbidden' }, 403),
    })).rejects.toThrow(
      'FAL image cost estimate failed (403): {"detail":"forbidden"}',
    );
  });
});

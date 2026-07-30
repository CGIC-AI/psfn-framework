import { isRecord } from '../../shared/utils/types.js';
import { sanitizeDiagnosticText } from '../../shared/diagnostics/redaction.js';

const FAL_PRICING_ESTIMATE_URL = 'https://api.fal.ai/v1/models/pricing/estimate';

export interface FalImageCostEstimate {
  totalUsd: number;
  currency: 'USD';
  source: 'fal_unit_price_estimate';
  endpointId: string;
  unitQuantity: number;
}

export async function estimateFalImageRequestCost(params: {
  apiKey: string;
  endpointId: string;
  unitQuantity: number;
  fetchImpl?: typeof fetch;
}): Promise<FalImageCostEstimate> {
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    throw new Error('FAL API key is required for image cost estimation');
  }
  const endpointId = params.endpointId.trim();
  if (!endpointId) {
    throw new Error('FAL endpoint ID is required for image cost estimation');
  }
  if (!Number.isFinite(params.unitQuantity) || params.unitQuantity <= 0) {
    throw new Error('FAL image cost estimate unitQuantity must be a positive finite number');
  }

  const response = await (params.fetchImpl ?? fetch)(FAL_PRICING_ESTIMATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      estimate_type: 'unit_price',
      endpoints: {
        [endpointId]: {
          unit_quantity: params.unitQuantity,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = sanitizeDiagnosticText(await response.text());
    throw new Error(
      `FAL image cost estimate failed (${response.status}): ${body || response.statusText}`,
    );
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error('FAL image cost estimate response must be a JSON object');
  }
  if (payload.estimate_type !== 'unit_price') {
    throw new Error('FAL image cost estimate response has an unexpected estimate_type');
  }
  if (
    typeof payload.total_cost !== 'number'
    || !Number.isFinite(payload.total_cost)
    || payload.total_cost <= 0
  ) {
    throw new Error('FAL image cost estimate response total_cost must be a positive finite number');
  }
  if (payload.currency !== 'USD') {
    throw new Error('FAL image cost estimate response currency must be USD');
  }

  return {
    totalUsd: payload.total_cost,
    currency: 'USD',
    source: 'fal_unit_price_estimate',
    endpointId,
    unitQuantity: params.unitQuantity,
  };
}

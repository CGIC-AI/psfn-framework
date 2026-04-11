import { describe, expect, it } from 'vitest';
import { createOpenHomeSatelliteAdapterPort } from './adapter.js';

describe('createOpenHomeSatelliteAdapterPort', () => {
  it('exposes the OpenHome channel adapter through the satellite port', async () => {
    const adapterPort = createOpenHomeSatelliteAdapterPort();

    expect(adapterPort.id).toBe('psfn-amica');
    expect(adapterPort.channel?.manifest).toEqual({
      id: 'psfn-amica',
      label: 'PSFN Amica',
      enabled: true,
      required: false,
      eligibility: {},
    });

    const channelAdapter = await adapterPort.channel?.create();
    expect(channelAdapter?.id).toBe('psfn-amica');
    expect(channelAdapter?.meta.label).toBe('PSFN Amica');
    expect(channelAdapter?.capabilities.promptChannelType).toBe('psfn-amica');
  });
});

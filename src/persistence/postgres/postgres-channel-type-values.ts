import { CHANNEL_TYPES } from '../../shared/contracts/channel-types.js';

export const POSTGRES_CHANNEL_TYPE_VALUES = CHANNEL_TYPES.map(channelType => `'${channelType}'`).join(', ');

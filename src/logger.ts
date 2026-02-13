// ── Structured Logger ──
// Winston-based logger with configurable levels via LOG_LEVEL env var.
// Usage: import { logger } from './logger.js';
//        logger.info('message', { key: 'value' });

import { createLogger, format, transports } from 'winston';

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

export const logger = createLogger({
  level: LOG_LEVEL,
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4,
  },
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ timestamp, level, message, component, ...meta }) => {
      const tag = component ? `[${component}]` : '';
      const extra = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} ${level.toUpperCase().padEnd(5)} ${tag} ${message}${extra}`;
    }),
  ),
  transports: [
    new transports.Console(),
  ],
});

/** Create a child logger with a fixed component tag */
export function createComponentLogger(component: string) {
  return logger.child({ component });
}

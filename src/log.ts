import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const log = pino({
  level,
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

export type Logger = pino.Logger;

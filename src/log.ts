import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

// Logs go to stderr (fd 2) so stdout is reserved for command output — the
// `export` and `schema` commands write machine-readable JSON to stdout that
// must not be interleaved with extraction logs.
export const log =
  process.env.NODE_ENV !== 'production'
    ? pino({ level, transport: { target: 'pino-pretty', options: { colorize: true, destination: 2 } } })
    : pino({ level }, pino.destination(2));

export type Logger = pino.Logger;

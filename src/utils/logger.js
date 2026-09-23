'use strict';

/**
 * Lightweight structured logger.
 * Outputs JSON lines in production, human-readable in development.
 */
const IS_PROD = process.env.NODE_ENV === 'production';

function _log(level, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };

  if (IS_PROD) {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const color = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', debug: '\x1b[90m' };
    const reset = '\x1b[0m';
    const c = color[level] || '';
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`${c}[${entry.ts}] [${level.toUpperCase()}]${reset} ${message}${metaStr}`);
  }
}

const logger = {
  info:  (msg, meta = {}) => _log('info', msg, meta),
  warn:  (msg, meta = {}) => _log('warn', msg, meta),
  error: (msg, meta = {}) => _log('error', msg, meta),
  debug: (msg, meta = {}) => _log('debug', msg, meta),
};

module.exports = { logger };

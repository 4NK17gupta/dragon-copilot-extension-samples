/**
 * Lightweight scoped console logger for the sandbox server.
 *
 * Produces consistently prefixed output so that activity is easy to follow
 * in the terminal during `npm run dev`. Each log line is tagged with the
 * server prefix and a scope (e.g. "manifest", "capabilities", "extension-call").
 */

const PREFIX = '[sandbox-server]';

function timestamp(): string {
  return new Date().toISOString();
}

export interface ScopedLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

/**
 * Creates a logger bound to a named scope. Example:
 *   const log = createLogger('manifest');
 *   log.info('Validating manifest...');
 *   // => [sandbox-server] [2026-06-25T...] [manifest] Validating manifest...
 */
export function createLogger(scope: string): ScopedLogger {
  const tag = `${PREFIX} [${scope}]`;
  return {
    info: (message: string, ...args: unknown[]) =>
      console.log(`${tag} ${timestamp()} ${message}`, ...args),
    warn: (message: string, ...args: unknown[]) =>
      console.warn(`${tag} ${timestamp()} ⚠ ${message}`, ...args),
    error: (message: string, ...args: unknown[]) =>
      console.error(`${tag} ${timestamp()} ✖ ${message}`, ...args),
  };
}

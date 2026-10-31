import type { NextFunction, Request, Response } from 'express';
import { isLoopbackHostname } from '../utils/loopback.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('http');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `host[:port]` where host is a bracketed IPv6 literal or a name without userinfo or path characters. */
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[^:[\]@/?#\s]+)(?::\d{1,5})?$/i;

function isLocalHostHeader(host: string | undefined): boolean {
  const match = host ? HOST_HEADER.exec(host) : null;
  return match !== null && isLoopbackHostname(match[1]);
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.origin === origin
      && (url.protocol === 'http:' || url.protocol === 'https:')
      && isLoopbackHostname(url.hostname);
  } catch {
    // Includes the opaque origin "null" (sandboxed iframes, file:// pages).
    return false;
  }
}

/**
 * Rejects requests that did not come from this machine's own pages or tools.
 *
 * - The Host header must name the loopback interface. Binding to 127.0.0.1 is
 *   not enough on its own: with DNS rebinding, a page on attacker.example
 *   re-points its own name at 127.0.0.1, and the browser then sends
 *   `Host: attacker.example:4000`.
 * - On state-changing methods, a browser's Origin must also be local. CORS only
 *   stops a foreign page from reading the response; a multipart POST such as a
 *   manifest upload needs no preflight and would still run. Requests without an
 *   Origin (curl, the C# sample, other local tools) are allowed.
 */
export function localRequestGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalHostHeader(req.headers.host)) {
    log.warn(`${req.method} ${req.path} rejected: the Host header is not localhost (403).`);
    res.status(403).json({ error: 'Requests must be addressed to localhost.' });
    return;
  }

  const { origin } = req.headers;
  if (origin !== undefined && !SAFE_METHODS.has(req.method) && !isLocalOrigin(origin)) {
    log.warn(`${req.method} ${req.path} rejected: the Origin is not a localhost page (403).`);
    res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    return;
  }

  next();
}

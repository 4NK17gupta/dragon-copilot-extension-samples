import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '../utils/logger.js';

const log = createLogger('server');

/** Client-safe messages for body-parser failures, keyed by the error's `type`. */
const BODY_ERROR_MESSAGES = new Map<string, string>([
  ['entity.parse.failed', 'Request body is not valid JSON.'],
  ['entity.too.large', 'Request body is too large.'],
  ['charset.unsupported', 'Request body uses an unsupported charset.'],
  ['encoding.unsupported', 'Request body uses an unsupported content encoding.'],
  ['request.aborted', 'Request body was incomplete.'],
  ['request.size.invalid', 'Request body was incomplete.'],
]);

interface ErrorFields {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
}

/**
 * Final Express error handler.
 *
 * It never logs the error object itself: body-parser errors carry the raw
 * request body on `err.body`, and Node's JSON.parse messages quote part of the
 * input, so either could write PHI to the console. Client errors (4xx, such as
 * malformed JSON or an oversized body) keep their status and get a fixed
 * message instead of being reported as a 500.
 */
export function globalErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const fields: ErrorFields = typeof err === 'object' && err !== null ? err : {};
  const status = typeof fields.status === 'number' ? fields.status
    : typeof fields.statusCode === 'number' ? fields.statusCode
      : 500;
  const type = typeof fields.type === 'string' ? fields.type : undefined;

  if (status >= 400 && status < 500) {
    log.warn(`${req.method} ${req.path} rejected with ${status}${type ? ` (${type})` : ''}.`);
    res.status(status).json({
      error: (type && BODY_ERROR_MESSAGES.get(type)) ?? 'The request could not be processed.',
    });
    return;
  }

  // The stack (name, message and frames) is enough to debug; the error's own
  // properties, where libraries attach request data, are left out.
  const name = typeof fields.name === 'string' ? fields.name : 'error';
  const detail = typeof fields.stack === 'string' ? fields.stack
    : typeof fields.message === 'string' ? fields.message
      : 'No error details.';
  log.error(`Unhandled ${name} while processing ${req.method} ${req.path}.`, detail);
  res.status(500).json({ error: 'Internal server error' });
}

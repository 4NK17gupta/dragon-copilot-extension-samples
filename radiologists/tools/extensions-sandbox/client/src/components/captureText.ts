import type { PartnerInitiatedResult } from '../types/testing';

/**
 * The status with Dragon Copilot's reason, such as "409 ResultAlreadyStored", or with the status
 * text when the response has no reason, such as "200 OK".
 */
export function describeOutcome(result: Pick<PartnerInitiatedResult, 'status' | 'statusText' | 'responseBody'>): string {
  const body = result.responseBody;
  const reason = typeof body === 'object' && body !== null && 'reason' in body && typeof body.reason === 'string'
    ? body.reason
    : result.statusText;
  return `${result.status} ${reason}`.trim();
}

/** The local time a captured request was received. */
export function formatReceivedTime(receivedAt: string): string {
  return new Date(receivedAt).toLocaleTimeString();
}

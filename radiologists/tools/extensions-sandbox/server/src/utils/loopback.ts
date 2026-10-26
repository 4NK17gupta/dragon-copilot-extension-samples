/**
 * Hostnames that always mean this machine. Matching is exact on purpose: a DNS
 * name that merely resolves to 127.0.0.1 is how DNS rebinding works, so it
 * must not count as local.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Returns true when `hostname` (in `URL.hostname` form, IPv6 in brackets) names this machine. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

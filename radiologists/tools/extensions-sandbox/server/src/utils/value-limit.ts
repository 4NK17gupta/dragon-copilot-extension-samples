/**
 * Counts the values (objects, arrays and scalars) reachable from `root`, stopping
 * as soon as `limit` is exceeded so the walk is bounded even for huge or cyclic input.
 */
export function exceedsValueLimit(root: unknown, limit: number): boolean {
  const pending: unknown[] = [root];
  let count = 1;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object') {
      continue;
    }
    for (const child of Object.values(value)) {
      if (++count > limit) {
        return true;
      }
      pending.push(child);
    }
  }
  return false;
}

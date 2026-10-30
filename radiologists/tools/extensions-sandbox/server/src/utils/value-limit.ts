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

/**
 * Whether objects and arrays in `root` nest more than `limit` levels deep, counting
 * `root` itself as level 1. Iterative, so even very deep input can't overflow the stack.
 */
export function exceedsDepthLimit(root: unknown, limit: number): boolean {
  const pending: [value: object, depth: number][] = [];
  if (root !== null && typeof root === 'object') {
    pending.push([root, 1]);
  }
  while (pending.length > 0) {
    const [value, depth] = pending.pop()!;
    if (depth > limit) {
      return true;
    }
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === 'object') {
        pending.push([child, depth + 1]);
      }
    }
  }
  return false;
}

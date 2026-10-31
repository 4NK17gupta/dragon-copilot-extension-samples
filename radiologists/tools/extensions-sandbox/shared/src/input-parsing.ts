/**
 * Thrown when form inputs cannot be parsed safely: the inputs are not an object
 * of strings, or a name uses a reserved key that could change an object's
 * prototype.
 */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

const RESERVED_NAME_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Input names become object keys, so `__proto__.x` would otherwise write to
 * `Object.prototype` for the whole process.
 */
function assertSafeInputName(name: string): void {
  if (name.split('.').some((segment) => RESERVED_NAME_SEGMENTS.has(segment))) {
    throw new InvalidInputError(
      `Input name '${name}' is not allowed: '__proto__', 'prototype' and 'constructor' are reserved.`,
    );
  }
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Parses form input values (strings) into their appropriate types.
 * Only parses values that look like JSON objects or arrays — primitive-looking
 * strings (numbers, booleans) are kept as strings to avoid silent type coercion
 * of clinical identifiers like MRNs or accession numbers.
 *
 * @throws InvalidInputError if `inputs` is not an object of strings or uses a reserved name.
 */
export function parseInputValues(inputs: Record<string, string>): Record<string, unknown> {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new InvalidInputError('inputs must be an object whose values are strings.');
  }
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    assertSafeInputName(key);
    if (typeof value !== 'string') {
      throw new InvalidInputError(`Input '${key}' must be a string.`);
    }
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        parsed[key] = JSON.parse(value);
      } catch {
        parsed[key] = value;
      }
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

/**
 * Groups flat dot-delimited field paths (e.g. "report.reportText") into nested
 * objects keyed by the input name. Non-dotted keys are kept as-is.
 * Empty/null/undefined values are omitted from the result, and a group whose
 * fields are all empty is omitted entirely rather than left as an empty object.
 *
 * @throws InvalidInputError if a path uses a reserved name.
 */
export function groupInputsByName(parsedInputs: Record<string, unknown>): Record<string, unknown> {
  const grouped: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(parsedInputs)) {
    assertSafeInputName(path);
    const dotIndex = path.indexOf('.');
    if (dotIndex > 0) {
      const inputName = path.slice(0, dotIndex);
      const fieldName = path.slice(dotIndex + 1);
      if (value !== '' && value !== null && value !== undefined) {
        if (!hasOwn(grouped, inputName) || !grouped[inputName] || typeof grouped[inputName] !== 'object') {
          grouped[inputName] = {};
        }
        (grouped[inputName] as Record<string, unknown>)[fieldName] = value;
      }
    } else {
      if (value !== '' && value !== null && value !== undefined) {
        grouped[path] = value;
      }
    }
  }
  return grouped;
}

/**
 * Convenience: parse raw string inputs and group them by name in one step.
 *
 * @throws InvalidInputError if `inputs` is not an object of strings or uses a reserved name.
 */
export function parseAndGroupInputs(inputs: Record<string, string>): Record<string, unknown> {
  return groupInputsByName(parseInputValues(inputs));
}

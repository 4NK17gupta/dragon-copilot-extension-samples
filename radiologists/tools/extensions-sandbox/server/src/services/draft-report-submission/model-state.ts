/**
 * Collects validation errors by key and lists them in the order ASP.NET Core's ModelStateDictionary
 * does, so the `errors` object matches Dragon Copilot's key for key.
 */

/** MvcOptions.MaxModelValidationErrors: ModelStateDictionary keeps no more errors than this. */
export const MAX_MODEL_ERRORS = 200;

/**
 * The message ASP.NET Core writes for the error that marks the limit. That error holds an exception
 * and no message, so the response gives ValidationProblemDetails' default message instead.
 */
export const TOO_MANY_ERRORS_MESSAGE = 'The input was not valid.';

interface KeyNode {
  /** The part of the key this node adds: a name, or an index such as `[0]`. */
  segment: string;
  /** The first full key that resolved to this node. */
  key?: string;
  messages?: string[];
  /** Keyed by `childKey(segment)`. */
  children: Map<string, KeyNode>;
}

function compareSegments(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  const a = left.toUpperCase();
  const b = right.toUpperCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Equal for two segments exactly when `compareSegments` finds them equal. */
function childKey(segment: string): string {
  return `${segment.length}\0${segment.toUpperCase()}`;
}

/**
 * Splits a key the way ModelStateDictionary does: at each `.`, and before each `[`, which stays with
 * the segment that follows. An empty segment, as in `$.`, stays on the same node.
 */
function segments(key: string): string[] {
  const parts: string[] = [];
  let index = 0;
  let afterBracket = false;
  for (;;) {
    let end = index;
    while (end < key.length && key[end] !== '.' && key[end] !== '[') {
      end++;
    }
    parts.push(key.slice(afterBracket ? index - 1 : index, end));
    if (end >= key.length) {
      return parts.filter((part) => part.length > 0);
    }
    afterBracket = key[end] === '[';
    index = end + 1;
  }
}

export class ModelState {
  private readonly root: KeyNode = { segment: '', children: new Map() };
  private count = 0;
  private reachedMax = false;

  /**
   * Adds an error under a key. Keys are case-insensitive, as in ASP.NET Core. As in
   * ModelStateDictionary, the error that would be the 200th is replaced by one under the empty key,
   * and later errors are dropped.
   */
  add(key: string, message: string): void {
    if (this.count >= MAX_MODEL_ERRORS - 1) {
      if (!this.reachedMax) {
        this.reachedMax = true;
        this.addError('', TOO_MANY_ERRORS_MESSAGE);
      }
      return;
    }
    this.addError(key, message);
  }

  /** The number of errors. */
  get errorCount(): number {
    return this.count;
  }

  get isValid(): boolean {
    return this.count === 0;
  }

  /** The errors in the order ASP.NET Core writes them: breadth first, siblings sorted by length and then by name. */
  toErrors(): Record<string, string[]> {
    const errors: Record<string, string[]> = {};
    const add = (node: KeyNode) => {
      if (node.messages) {
        errors[node.key ?? ''] = [...node.messages];
      }
    };
    add(this.root);
    const queue: KeyNode[] = [this.root];
    for (let index = 0; index < queue.length; index++) {
      const children = [...queue[index].children.values()].sort((left, right) => compareSegments(left.segment, right.segment));
      for (const child of children) {
        add(child);
        if (child.children.size > 0) {
          queue.push(child);
        }
      }
    }
    return errors;
  }

  private addError(key: string, message: string): void {
    const node = this.nodeFor(key);
    (node.messages ??= []).push(message);
    this.count++;
  }

  private nodeFor(key: string): KeyNode {
    let node = this.root;
    for (const segment of segments(key)) {
      const id = childKey(segment);
      let child = node.children.get(id);
      if (!child) {
        child = { segment, children: new Map() };
        node.children.set(id, child);
      }
      node = child;
    }
    node.key ??= key;
    return node;
  }
}

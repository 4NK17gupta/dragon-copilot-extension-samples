/**
 * Collects validation errors by key and lists them in the order ASP.NET Core's ModelStateDictionary
 * does, so the `errors` object matches Dragon Copilot's key for key.
 */

interface KeyNode {
  /** The part of the key this node adds: a name, or an index such as `[0]`. */
  segment: string;
  /** The first full key that resolved to this node. */
  key?: string;
  messages?: string[];
  children: KeyNode[];
}

function compareSegments(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  const a = left.toUpperCase();
  const b = right.toUpperCase();
  return a < b ? -1 : a > b ? 1 : 0;
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
  private readonly root: KeyNode = { segment: '', children: [] };
  private count = 0;

  /** Adds an error under a key. Keys are case-insensitive, as in ASP.NET Core. */
  add(key: string, message: string): void {
    const node = this.nodeFor(key);
    if (!node.messages) {
      node.messages = [];
      this.count++;
    }
    node.messages.push(message);
  }

  /** The number of keys with errors. */
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
      for (const child of queue[index].children) {
        add(child);
        if (child.children.length > 0) {
          queue.push(child);
        }
      }
    }
    return errors;
  }

  private nodeFor(key: string): KeyNode {
    let node = this.root;
    for (const segment of segments(key)) {
      let child = node.children.find((candidate) => compareSegments(candidate.segment, segment) === 0);
      if (!child) {
        child = { segment, children: [] };
        const position = node.children.findIndex((candidate) => compareSegments(segment, candidate.segment) < 0);
        node.children.splice(position === -1 ? node.children.length : position, 0, child);
      }
      node = child;
    }
    node.key ??= key;
    return node;
  }
}

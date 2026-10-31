/**
 * Tokenizes UTF-8 JSON the way System.Text.Json's Utf8JsonReader does, so a malformed body is
 * reported with the message, line number and byte position Dragon Copilot gives for it.
 */

/** The deepest nesting Dragon Copilot reads: ASP.NET Core's default for request bodies. */
export const MAX_DEPTH = 32;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;
const UPPER_E = 0x45;
const LOWER_E = 0x65;
const LOWER_U = 0x75;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const TAB = 0x09;
const SPACE = 0x20;
const SLASH = 0x2f;

/** Bytes that can end a number. */
const NUMBER_DELIMITERS = new Set([COMMA, CLOSE_BRACE, CLOSE_BRACKET, SPACE, LINE_FEED, CARRIAGE_RETURN, TAB, SLASH]);

/** Bytes that can follow a backslash, besides a quote and another backslash. */
const ESCAPABLE = new Set([...'nrt/ubf'].map((character) => character.charCodeAt(0)));

const LITERALS = {
  true: new TextEncoder().encode('true'),
  false: new TextEncoder().encode('false'),
  null: new TextEncoder().encode('null'),
} as const;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder('utf-8', { ignoreBOM: true });
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const SHORT_ESCAPES: Record<number, string> = {
  [QUOTE]: '"',
  [BACKSLASH]: '\\',
  [SLASH]: '/',
  0x62: '\b',
  0x66: '\f',
  0x6e: '\n',
  0x72: '\r',
  0x74: '\t',
};

export type JsonTokenType =
  | 'startObject'
  | 'endObject'
  | 'startArray'
  | 'endArray'
  | 'propertyName'
  | 'string'
  | 'number'
  | 'true'
  | 'false'
  | 'null';

/** A syntax error, with the line and byte position System.Text.Json reports for it. */
export class JsonReaderError extends Error {
  constructor(message: string, readonly lineNumber: number, readonly bytePositionInLine: number) {
    super(message);
    this.name = 'JsonReaderError';
  }
}

function isDigit(byte: number): boolean {
  return byte >= ZERO && byte <= NINE;
}

function isHexDigit(byte: number): boolean {
  return isDigit(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

/** Quotes a byte the way System.Text.Json does in its messages. */
function printable(byte: number): string {
  return byte >= SPACE && byte < 0x7f
    ? `'${String.fromCharCode(byte)}'`
    : `'0x${byte.toString(16).toUpperCase().padStart(2, '0')}'`;
}

/**
 * Reads JSON one token at a time. Line numbers and byte positions are zero-based, and positions are
 * counted in UTF-8 bytes, as in Dragon Copilot's messages.
 */
export class Utf8JsonReader {
  tokenType: JsonTokenType | null = null;
  private valueStart = 0;
  private valueEnd = 0;
  private consumed = 0;
  private lineNumber = 0;
  private lineStart = 0;
  private readonly containers: boolean[] = [];

  constructor(private readonly data: Uint8Array) {}

  /** The line of the current token. */
  get line(): number {
    return this.lineNumber;
  }

  /** The byte position in the line just after the current token. */
  get bytePositionAfterToken(): number {
    return this.consumed - this.lineStart;
  }

  /**
   * Reads the next token. Returns false at the end of the data once the top-level value is complete.
   * @throws {JsonReaderError} When the JSON is malformed.
   */
  read(): boolean {
    this.skipWhiteSpace();
    if (this.consumed >= this.data.length) {
      if (this.tokenType === null) {
        this.fail('The input does not contain any JSON tokens. Expected the input to start with a valid JSON token, when isFinalBlock is true.');
      }
      if (this.containers.length !== 0) {
        this.fail('Expected depth to be zero at the end of the JSON payload. There is an open JSON object or array that should be closed.');
      }
      return false;
    }

    const first = this.data[this.consumed];
    switch (this.tokenType) {
      case null:
      case 'propertyName':
        this.consumeValue(first);
        break;
      case 'startObject':
        if (first === CLOSE_BRACE) {
          this.endContainer('endObject');
        } else if (first === QUOTE) {
          this.consumePropertyName();
        } else {
          this.fail(`${printable(first)} is an invalid start of a property name. Expected a '"'.`);
        }
        break;
      case 'startArray':
        if (first === CLOSE_BRACKET) {
          this.endContainer('endArray');
        } else {
          this.consumeValue(first);
        }
        break;
      default:
        this.consumeAfterValue(first);
        break;
    }
    return true;
  }

  /** Skips the current value, including everything inside it when it is an object or array. */
  skip(): void {
    if (this.tokenType === 'startObject' || this.tokenType === 'startArray') {
      const depth = this.containers.length;
      while (this.containers.length >= depth) {
        this.read();
      }
    }
  }

  /**
   * Gets the current string, or undefined when it isn't valid UTF-8 or contains an unpaired
   * surrogate, which Dragon Copilot can't convert to a string.
   */
  getString(): string | undefined {
    return this.decode(true);
  }

  /**
   * Gets the current property name. As in Dragon Copilot, invalid UTF-8 in a name is tolerated but an
   * escaped unpaired surrogate is not.
   */
  getPropertyName(): string | undefined {
    return this.decode(false);
  }

  /** Gets the text of the current number. */
  getNumberText(): string {
    return lenientUtf8.decode(this.data.subarray(this.valueStart, this.valueEnd));
  }

  private fail(message: string, at = this.consumed): never {
    throw new JsonReaderError(message, this.lineNumber, at - this.lineStart);
  }

  private skipWhiteSpace(): void {
    const { data } = this;
    while (this.consumed < data.length) {
      const byte = data[this.consumed];
      if (byte === LINE_FEED) {
        this.consumed++;
        this.lineNumber++;
        this.lineStart = this.consumed;
      } else if (byte === SPACE || byte === TAB || byte === CARRIAGE_RETURN) {
        this.consumed++;
      } else {
        return;
      }
    }
  }

  private get inObject(): boolean {
    return this.containers[this.containers.length - 1] === true;
  }

  private consumeAfterValue(first: number): void {
    if (this.containers.length === 0) {
      this.fail(`${printable(first)} is invalid after a single JSON value. Expected end of data.`);
    }
    if (first === CLOSE_BRACE || first === CLOSE_BRACKET) {
      const closesObject = first === CLOSE_BRACE;
      if (closesObject !== this.inObject) {
        this.fail(`${printable(first)} is invalid without a matching open.`);
      }
      this.endContainer(closesObject ? 'endObject' : 'endArray');
      return;
    }
    if (first !== COMMA) {
      this.fail(`${printable(first)} is invalid after a value. Expected either ',', '}', or ']'.`);
    }

    const comma = this.consumed;
    this.consumed++;
    if (this.consumed >= this.data.length) {
      this.fail('Expected start of a property name or value, but instead reached end of data.', comma);
    }
    this.skipWhiteSpace();
    if (this.consumed >= this.data.length) {
      this.fail('Expected start of a property name or value, but instead reached end of data.');
    }

    const next = this.data[this.consumed];
    if (this.inObject) {
      if (next === CLOSE_BRACE) {
        this.fail('The JSON object contains a trailing comma at the end which is not supported in this mode. Change the reader options.');
      }
      if (next !== QUOTE) {
        this.fail(`${printable(next)} is an invalid start of a property name. Expected a '"'.`);
      }
      this.consumePropertyName();
    } else {
      if (next === CLOSE_BRACKET) {
        this.fail('The JSON array contains a trailing comma at the end which is not supported in this mode. Change the reader options.');
      }
      this.consumeValue(next);
    }
  }

  private consumeValue(first: number): void {
    if (first === QUOTE) {
      this.consumeString();
      this.tokenType = 'string';
    } else if (first === OPEN_BRACE || first === OPEN_BRACKET) {
      const isObject = first === OPEN_BRACE;
      if (this.containers.length >= MAX_DEPTH) {
        this.fail(`The maximum configured depth of ${MAX_DEPTH} has been exceeded. Cannot read next JSON ${isObject ? 'object' : 'array'}.`);
      }
      this.containers.push(isObject);
      this.consumed++;
      this.tokenType = isObject ? 'startObject' : 'startArray';
    } else if (first === MINUS || isDigit(first)) {
      this.consumeNumber();
    } else if (first === LITERALS.true[0]) {
      this.consumeLiteral('true');
    } else if (first === LITERALS.false[0]) {
      this.consumeLiteral('false');
    } else if (first === LITERALS.null[0]) {
      this.consumeLiteral('null');
    } else {
      this.fail(`${printable(first)} is an invalid start of a value.`);
    }
  }

  private endContainer(tokenType: 'endObject' | 'endArray'): void {
    this.containers.pop();
    this.consumed++;
    this.tokenType = tokenType;
  }

  private consumePropertyName(): void {
    this.consumeString();
    this.skipWhiteSpace();
    if (this.consumed >= this.data.length) {
      this.fail('Expected a value, but instead reached end of data.');
    }
    const separator = this.data[this.consumed];
    if (separator !== COLON) {
      this.fail(`${printable(separator)} is invalid after a property name. Expected a ':'.`);
    }
    this.consumed++;
    this.tokenType = 'propertyName';
  }

  private consumeString(): void {
    const { data } = this;
    const start = this.consumed;
    for (let index = start + 1; index < data.length; index++) {
      const byte = data[index];
      if (byte === QUOTE) {
        this.valueStart = start + 1;
        this.valueEnd = index;
        this.consumed = index + 1;
        return;
      }
      if (byte === BACKSLASH) {
        index++;
        if (index >= data.length) {
          break;
        }
        const escaped = data[index];
        if (escaped === QUOTE || escaped === BACKSLASH) {
          continue;
        }
        if (!ESCAPABLE.has(escaped)) {
          this.fail(`${printable(escaped)} is an invalid escapable character within a JSON string. The string should be correctly escaped.`, index);
        }
        if (escaped === LOWER_U) {
          for (let digit = 0; digit < 4; digit++) {
            index++;
            if (index >= data.length) {
              this.fail('Expected end of string, but instead reached end of data.', data.length);
            }
            if (!isHexDigit(data[index])) {
              this.fail(`${printable(data[index])} is not a hex digit following '\\u' within a JSON string. The string should be correctly escaped.`, index);
            }
          }
        }
      } else if (byte < SPACE) {
        this.fail(`${printable(byte)} is invalid within a JSON string. The string should be correctly escaped.`, index);
      }
    }
    this.fail('Expected end of string, but instead reached end of data.', data.length);
  }

  private consumeNumber(): void {
    const { data } = this;
    const start = this.consumed;
    const end = data.length;
    const endOfData = "Expected a digit ('0'-'9'), but instead reached end of data.";
    const afterSign = (byte: number) =>
      `${printable(byte)} is invalid within a number, immediately after a sign character ('+' or '-'). Expected a digit ('0'-'9').`;
    const delimiterExpected = (byte: number) => `${printable(byte)} is an invalid end of a number. Expected a delimiter.`;
    const isComplete = (index: number) => index >= end || NUMBER_DELIMITERS.has(data[index]);

    let index = start;
    if (data[index] === MINUS) {
      index++;
      if (index >= end) {
        this.fail(endOfData, index);
      }
      if (!isDigit(data[index])) {
        this.fail(afterSign(data[index]), index);
      }
    }

    if (data[index] === ZERO) {
      index++;
      if (isComplete(index)) {
        this.finishNumber(start, index);
        return;
      }
      const next = data[index];
      if (next !== DOT && next !== UPPER_E && next !== LOWER_E) {
        this.fail(isDigit(next) ? `Invalid leading zero before ${printable(next)}.` : delimiterExpected(next), index);
      }
    } else {
      while (index < end && isDigit(data[index])) {
        index++;
      }
      if (isComplete(index)) {
        this.finishNumber(start, index);
        return;
      }
      const next = data[index];
      if (next !== DOT && next !== UPPER_E && next !== LOWER_E) {
        this.fail(delimiterExpected(next), index);
      }
    }

    if (data[index] === DOT) {
      index++;
      if (index >= end) {
        this.fail(endOfData, index);
      }
      if (!isDigit(data[index])) {
        this.fail(`${printable(data[index])} is invalid within a number, immediately after a decimal point ('.'). Expected a digit ('0'-'9').`, index);
      }
      while (index < end && isDigit(data[index])) {
        index++;
      }
      if (isComplete(index)) {
        this.finishNumber(start, index);
        return;
      }
      if (data[index] !== UPPER_E && data[index] !== LOWER_E) {
        this.fail(`${printable(data[index])} is an invalid end of a number. Expected 'E' or 'e'.`, index);
      }
    }

    // The exponent.
    index++;
    if (index >= end) {
      this.fail(endOfData, index);
    }
    if (data[index] === PLUS || data[index] === MINUS) {
      index++;
      if (index >= end) {
        this.fail(endOfData, index);
      }
    }
    if (!isDigit(data[index])) {
      this.fail(afterSign(data[index]), index);
    }
    while (index < end && isDigit(data[index])) {
      index++;
    }
    if (!isComplete(index)) {
      this.fail(delimiterExpected(data[index]), index);
    }
    this.finishNumber(start, index);
  }

  private finishNumber(start: number, end: number): void {
    this.valueStart = start;
    this.valueEnd = end;
    this.consumed = end;
    this.tokenType = 'number';
    // Inside an object or array, a number must be followed by a delimiter.
    if (end >= this.data.length && this.containers.length !== 0) {
      this.fail(`${printable(this.data[end - 1])} is an invalid end of a number. Expected a delimiter.`);
    }
  }

  private consumeLiteral(name: keyof typeof LITERALS): void {
    const literal = LITERALS[name];
    const { data } = this;
    const start = this.consumed;
    for (let offset = 1; offset < literal.length; offset++) {
      if (start + offset >= data.length || data[start + offset] !== literal[offset]) {
        const span = lenientUtf8.decode(data.subarray(start, Math.min(data.length, start + literal.length)));
        this.fail(`'${span}' is an invalid JSON literal. Expected the literal '${name}'.`, start + offset);
      }
    }
    this.consumed = start + literal.length;
    this.tokenType = name;
  }

  private decode(strict: boolean): string | undefined {
    const { data } = this;
    const decoder = strict ? strictUtf8 : lenientUtf8;
    let text = '';
    let run = this.valueStart;
    try {
      for (let index = this.valueStart; index < this.valueEnd; index++) {
        if (data[index] !== BACKSLASH) {
          continue;
        }
        text += decoder.decode(data.subarray(run, index));
        const escaped = data[index + 1];
        if (escaped === LOWER_U) {
          text += String.fromCharCode(Number.parseInt(lenientUtf8.decode(data.subarray(index + 2, index + 6)), 16));
          index += 5;
        } else {
          text += SHORT_ESCAPES[escaped];
          index += 1;
        }
        run = index + 1;
      }
      text += decoder.decode(data.subarray(run, this.valueEnd));
    } catch {
      return undefined;
    }
    return LONE_SURROGATE.test(text) ? undefined : text;
  }
}

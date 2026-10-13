/**
 * Guard for caller-supplied values that end up inside a URL path segment.
 *
 * encodeURIComponent alone keeps `.`/`..` intact, and pre-encoded separators
 * can be decoded again by intermediaries, so values that could change which
 * resource a request addresses are rejected before encoding.
 */
const FORBIDDEN_CHARACTERS = /[/\\?#]/;
const FORBIDDEN_ENCODINGS = /%(2e|2f|5c)/i;

export function assertSafePathParam(value: string | number, name = 'path parameter'): string {
  const text = String(value);
  if (text === '' || text === '.' || text === '..') {
    throw new Error(`Invalid ${name}: empty or dot segment.`);
  }
  if (FORBIDDEN_CHARACTERS.test(text) || FORBIDDEN_ENCODINGS.test(text)) {
    throw new Error(`Invalid ${name}: must not contain path separators, '?', '#', or encoded dots/slashes.`);
  }
  return text;
}

/** Validates a caller-supplied path parameter and percent-encodes it. */
export function encodePathParam(value: string | number, name?: string): string {
  return encodeURIComponent(assertSafePathParam(value, name));
}

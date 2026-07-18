export type CookieValidation =
  | { ok: true; value: string }
  | { ok: false; code: 'bad_cookie'; message: string };

// RFC 6265 cookie-name token characters (no separators or whitespace).
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validate a caller-supplied single cookie of the form `name=value`.
 *
 * Rejects: non-strings, control characters (CR/LF/NUL — header-injection),
 * multiple cookies (a `;` separator), empty names, invalid name tokens, and
 * unsafe value characters (whitespace, `"`, `,`, `;`, `\`). On success the
 * original `name=value` string is returned verbatim.
 */
export function validateExtraCookie(raw: unknown): CookieValidation {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'bad_cookie', message: 'extraCookie must be a string' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    return { ok: false, code: 'bad_cookie', message: 'extraCookie must not contain control characters' };
  }
  if (raw.includes(';')) {
    return { ok: false, code: 'bad_cookie', message: 'extraCookie must be a single name=value pair (no ";")' };
  }
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    return { ok: false, code: 'bad_cookie', message: 'extraCookie must be name=value with a non-empty name' };
  }
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (!COOKIE_NAME_RE.test(name)) {
    return { ok: false, code: 'bad_cookie', message: 'extraCookie name contains invalid characters' };
  }
  // cookie-octet: printable ASCII excluding whitespace, DQUOTE, comma, semicolon, backslash.
  if (!/^[\x21-\x7e]*$/.test(value) || /["\\,]/.test(value)) {
    return { ok: false, code: 'bad_cookie', message: 'extraCookie value contains invalid characters' };
  }
  return { ok: true, value: raw };
}

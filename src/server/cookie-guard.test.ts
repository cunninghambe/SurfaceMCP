import { describe, it, expect } from 'vitest';
import { validateExtraCookie } from './cookie-guard.js';

describe('validateExtraCookie', () => {
  it('accepts a simple name=value cookie', () => {
    const r = validateExtraCookie('session=abc123');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('session=abc123');
  });

  it('accepts values with base64/JWT-ish characters', () => {
    expect(validateExtraCookie('sid=eyJhbGciOi.J9-_=').ok).toBe(true);
    expect(validateExtraCookie('token=a.b.c').ok).toBe(true);
  });

  it('rejects multiple cookies (semicolon)', () => {
    const r = validateExtraCookie('a=1; b=2');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_cookie');
  });

  it('rejects a trailing attribute injection', () => {
    expect(validateExtraCookie('sid=x; HttpOnly').ok).toBe(false);
  });

  it('rejects CR/LF header injection', () => {
    expect(validateExtraCookie('sid=x\r\nSet-Cookie: evil=1').ok).toBe(false);
    expect(validateExtraCookie('sid=x\nfoo').ok).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(validateExtraCookie('=value').ok).toBe(false);
  });

  it('rejects a missing "="', () => {
    expect(validateExtraCookie('justname').ok).toBe(false);
  });

  it('rejects an invalid name token', () => {
    expect(validateExtraCookie('bad name=1').ok).toBe(false);
    expect(validateExtraCookie('na;me=1').ok).toBe(false);
  });

  it('rejects whitespace or quotes in the value', () => {
    expect(validateExtraCookie('sid=a b').ok).toBe(false);
    expect(validateExtraCookie('sid="quoted"').ok).toBe(false);
    expect(validateExtraCookie('sid=a,b').ok).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(validateExtraCookie(undefined).ok).toBe(false);
    expect(validateExtraCookie(42).ok).toBe(false);
  });
});

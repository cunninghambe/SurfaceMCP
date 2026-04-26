import type { AuthConfig } from '../types.js';
import { resolveCredentials } from '../env/indirection.js';

type NextAuthConfig = Extract<AuthConfig, { kind: 'nextauth' }>;
type LoginResult = { ok: boolean; cookies: string[]; error?: string };

const DEFAULT_CSRF_PATH = '/api/auth/csrf';
const DEFAULT_CALLBACK_PATH = '/api/auth/callback/credentials';
const DEFAULT_COOKIE_NAME = 'next-auth.session-token';

export async function loginNextAuth(
  baseUrl: string,
  auth: NextAuthConfig,
  credentials: Record<string, string>
): Promise<LoginResult> {
  const resolved = resolveCredentials(credentials);
  const csrfPath = auth.csrfPath ?? DEFAULT_CSRF_PATH;
  const callbackPath = auth.callbackPath ?? DEFAULT_CALLBACK_PATH;

  // Step 1: Get CSRF token
  const csrfUrl = `${baseUrl.replace(/\/$/, '')}${csrfPath}`;
  let csrfToken: string;
  let csrfCookies: string[] = [];

  try {
    const csrfRes = await fetch(csrfUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
    const csrfBody = await csrfRes.json() as { csrfToken?: string };
    if (!csrfBody.csrfToken) {
      return { ok: false, cookies: [], error: 'No csrfToken in CSRF response' };
    }
    csrfToken = csrfBody.csrfToken;
  } catch (err) {
    return { ok: false, cookies: [], error: `CSRF fetch failed: ${String(err)}` };
  }

  // Step 2: POST credentials to callback
  const callbackUrl = `${baseUrl.replace(/\/$/, '')}${callbackPath}`;
  const fields: Record<string, string> = {
    csrfToken,
    callbackUrl: auth.callbackUrl ?? '/',
    json: 'true',
  };

  for (const [field, credKey] of Object.entries(auth.fields)) {
    fields[field] = resolved[credKey] ?? resolved[field] ?? '';
  }

  const cookieHeader = csrfCookies.join('; ');
  const body = new URLSearchParams(fields).toString();

  let sessionCookies: string[] = [];
  try {
    const callbackRes = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Cookie': cookieHeader,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });

    sessionCookies = callbackRes.headers.getSetCookie?.() ?? [];
    const allCookies = [...csrfCookies, ...sessionCookies];

    // Look for session cookie (with or without __Secure- prefix)
    const cookieName = auth.cookieName ?? DEFAULT_COOKIE_NAME;
    const hasSession = allCookies.some((c) =>
      c.startsWith(`${cookieName}=`) || c.startsWith(`__Secure-${cookieName}=`)
    );

    if (!hasSession && callbackRes.status >= 400) {
      return {
        ok: false,
        cookies: allCookies,
        error: `NextAuth callback returned ${callbackRes.status}`,
      };
    }

    return { ok: hasSession || callbackRes.status < 400, cookies: allCookies };
  } catch (err) {
    return { ok: false, cookies: [], error: `NextAuth callback failed: ${String(err)}` };
  }
}

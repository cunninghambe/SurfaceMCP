import type { AuthConfig } from '../types.js';

type PreLoginResult = {
  captured: Record<string, string>;
  cookies: string[];
};

/**
 * Execute a preLogin step: GET/POST a URL, capture a field or cookie.
 */
export async function runPreLogin(
  baseUrl: string,
  preLogin: Extract<Extract<AuthConfig, { kind: 'form' }>['preLogin'], object>,
  existingCookies: string[] = []
): Promise<PreLoginResult> {
  const url = `${baseUrl.replace(/\/$/, '')}${preLogin.path}`;
  const headers: Record<string, string> = {
    'Accept': 'application/json, text/html',
  };
  if (existingCookies.length > 0) {
    headers['Cookie'] = existingCookies.join('; ');
  }

  const res = await fetch(url, {
    method: preLogin.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });

  const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
  const captured: Record<string, string> = {};

  if (preLogin.captureCookieAs) {
    for (const cookieStr of setCookieHeaders) {
      const name = cookieStr.split('=')[0];
      const value = cookieStr.split('=')[1]?.split(';')[0] ?? '';
      if (name) captured[preLogin.captureCookieAs] = `${name}=${value}`;
    }
  }

  if (preLogin.captureBodyFieldAs) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore
    }

    if (preLogin.captureBodyRegex) {
      const re = new RegExp(preLogin.captureBodyRegex);
      const match = re.exec(body);
      if (match?.[1]) captured[preLogin.captureBodyFieldAs] = match[1];
    } else {
      // Try JSON first
      try {
        const json = JSON.parse(body) as Record<string, unknown>;
        const val = json[preLogin.captureBodyFieldAs];
        if (typeof val === 'string') captured[preLogin.captureBodyFieldAs] = val;
      } catch {
        // Try hidden input in HTML
        const inputMatch = new RegExp(
          `name=["']${preLogin.captureBodyFieldAs}["'][^>]*value=["']([^"']+)["']|value=["']([^"']+)["'][^>]*name=["']${preLogin.captureBodyFieldAs}["']`
        ).exec(body);
        if (inputMatch) {
          captured[preLogin.captureBodyFieldAs] = inputMatch[1] ?? inputMatch[2] ?? '';
        }
      }
    }
  }

  return { captured, cookies: setCookieHeaders };
}

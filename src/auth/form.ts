import type { AuthConfig } from '../types.js';
import { resolveCredentials } from '../env/indirection.js';
import { runPreLogin } from './prelogin.js';

type FormAuthConfig = Extract<AuthConfig, { kind: 'form' }>;
type LoginResult = { ok: boolean; cookies: string[]; error?: string };

function substituteCaptures(
  value: string,
  captured: Record<string, string>
): string {
  return value.replace(/\$captured\.(\w+)/g, (_, key: string) => captured[key] ?? '');
}

export async function loginForm(
  baseUrl: string,
  auth: FormAuthConfig,
  credentials: Record<string, string>
): Promise<LoginResult> {
  const resolved = resolveCredentials(credentials);
  let captured: Record<string, string> = {};
  const preLoginCookies: string[] = [];

  if (auth.preLogin) {
    const result = await runPreLogin(baseUrl, auth.preLogin, []);
    captured = result.captured;
    preLoginCookies.push(...result.cookies);
  }

  // Build login fields.
  // loginFields maps: (credential key OR captured key) → form POST field name.
  // Values in loginFields can also include $captured.<name> substitution patterns.
  const fields: Record<string, string> = {};
  for (const [field, postFieldName] of Object.entries(auth.loginFields)) {
    const credValue = resolved[field];
    const capturedValue = captured[field];

    if (credValue !== undefined) {
      // Credential value: substitute any $captured. references in it
      fields[postFieldName] = substituteCaptures(credValue, captured);
    } else if (capturedValue !== undefined) {
      // Captured value from preLogin step
      fields[postFieldName] = capturedValue;
    } else {
      // postFieldName itself might be a $captured. reference
      fields[postFieldName] = substituteCaptures(postFieldName, captured);
    }
  }

  const loginUrl = `${baseUrl.replace(/\/$/, '')}${auth.loginPath}`;
  const useJsonBody = auth.bodyFormat === 'json';
  const headers: Record<string, string> = {
    'Content-Type': useJsonBody
      ? 'application/json'
      : 'application/x-www-form-urlencoded',
  };
  if (preLoginCookies.length > 0) {
    headers['Cookie'] = preLoginCookies.join('; ');
  }

  const body = useJsonBody
    ? JSON.stringify(fields)
    : new URLSearchParams(fields).toString();
  const res = await fetch(loginUrl, {
    method: auth.loginMethod,
    headers,
    body: auth.loginMethod === 'POST' ? body : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });

  const cookies = res.headers.getSetCookie?.() ?? [];
  const allCookies = [...preLoginCookies, ...cookies];

  // Validate success
  const ok = checkSuccess(res, auth.successCheck, allCookies);
  if (!ok) {
    return {
      ok: false,
      cookies: allCookies,
      error: `Login failed: status ${res.status}, expected ${JSON.stringify(auth.successCheck)}`,
    };
  }

  return { ok: true, cookies: allCookies };
}

function checkSuccess(
  res: Response,
  check: FormAuthConfig['successCheck'],
  cookies: string[]
): boolean {
  switch (check.kind) {
    case 'redirect':
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location') ?? '';
        return loc.includes(check.to);
      }
      return false;
    case 'cookie':
      return cookies.some((c) => c.startsWith(`${check.name}=`));
    case 'status':
      return res.status === check.code;
    case 'localStorage':
    case 'dom_signal':
      // Browser-only signals; HTTP login step optimistically succeeds.
      return res.ok;
  }
}

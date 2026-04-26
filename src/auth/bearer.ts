import { resolveCredentials } from '../env/indirection.js';

type LoginResult = { ok: boolean; token: string; error?: string };

export function getBearer(credentials: Record<string, string>): LoginResult {
  const resolved = resolveCredentials(credentials);
  const token = resolved['token'] ?? resolved['bearer'] ?? '';
  if (!token) {
    return { ok: false, token: '', error: 'No token found in credentials (expected key: "token")' };
  }
  return { ok: true, token };
}

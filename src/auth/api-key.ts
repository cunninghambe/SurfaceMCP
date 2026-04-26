import type { AuthConfig } from '../types.js';
import { resolveCredentials } from '../env/indirection.js';

type ApiKeyConfig = Extract<AuthConfig, { kind: 'api_key' }>;

export type ApiKeyCredential = {
  header?: { name: string; value: string };
  query?: { name: string; value: string };
};

export function getApiKey(
  auth: ApiKeyConfig,
  credentials: Record<string, string>
): ApiKeyCredential {
  const resolved = resolveCredentials(credentials);
  const keyValue = resolved['api_key'] ?? resolved['key'] ?? '';

  if (auth.header) {
    return { header: { name: auth.header, value: keyValue } };
  }
  if (auth.query) {
    return { query: { name: auth.query, value: keyValue } };
  }
  // Default to X-API-Key header
  return { header: { name: 'X-API-Key', value: keyValue } };
}

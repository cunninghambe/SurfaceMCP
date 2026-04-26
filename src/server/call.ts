import type { ToolMeta, SurfaceCallResult, AuthConfig } from '../types.js';
import type { RoleMutex } from '../auth/role-mutex.js';
import { shouldAutoRelogin } from '../auth/refresh-policy.js';
import { getApiKey } from '../auth/api-key.js';
import { resolveCredentials } from '../env/indirection.js';
import { log } from '../log.js';

const BODY_MAX_BYTES = 64 * 1024; // 64 KB
const STREAM_TIMEOUT_MS = 5_000;

type CallParams = {
  tool: ToolMeta;
  role: string;
  input: Record<string, unknown>;
  baseUrl: string;
  projectName: string;
  auth: AuthConfig;
  roleMutex: RoleMutex;
  revision: number;
  allowExternal?: boolean;
  noAutoRelogin?: boolean;
  pinRevision?: number;
  currentRevision: number;
  timeoutMs?: number;
};

function buildHeaders(
  auth: AuthConfig,
  session: { cookies?: string[]; token?: string } | undefined,
  roleCredentials: Record<string, string>,
  projectName: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Surface-Origin': `surfacemcp/${projectName}`,
  };

  if (!session) return headers;

  switch (auth.kind) {
    case 'form':
    case 'nextauth':
      if (session.cookies && session.cookies.length > 0) {
        headers['Cookie'] = session.cookies
          .map((c) => c.split(';')[0])
          .join('; ');
      }
      break;
    case 'bearer':
      if (session.token) {
        headers['Authorization'] = `Bearer ${session.token}`;
      }
      break;
    case 'api_key': {
      const resolved = resolveCredentials(roleCredentials);
      const cred = getApiKey(auth, resolved);
      if (cred.header) {
        headers[cred.header.name] = cred.header.value;
      }
      break;
    }
    case 'none':
      break;
  }

  return headers;
}

async function readBodyWithLimit(
  res: Response,
  timeoutMs: number
): Promise<{ body: unknown; truncated: boolean }> {
  const contentType = res.headers.get('content-type') ?? '';

  if (!res.body) {
    return { body: null, truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  const reader = res.body.getReader();
  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }

      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
        setTimeout(() => resolve({ done: true, value: undefined }), remaining);
      });

      const result = await Promise.race([readPromise, timeoutPromise]);
      if (result.done) break;

      const chunk = result.value;
      totalBytes += chunk.length;

      if (totalBytes > BODY_MAX_BYTES) {
        // Keep only up to the limit
        const overflow = totalBytes - BODY_MAX_BYTES;
        chunks.push(chunk.slice(0, chunk.length - overflow));
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }

      chunks.push(chunk);
    }
  } catch {
    truncated = true;
  }

  const combined = new Uint8Array(totalBytes > BODY_MAX_BYTES ? BODY_MAX_BYTES : totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const text = new TextDecoder().decode(combined);

  if (contentType.includes('application/json')) {
    try {
      return { body: JSON.parse(text) as unknown, truncated };
    } catch {
      return { body: text, truncated };
    }
  }

  return { body: text, truncated };
}

export async function executeCall(params: CallParams): Promise<SurfaceCallResult> {
  const start = Date.now();

  // Check revision pin
  if (params.pinRevision !== undefined && params.currentRevision !== params.pinRevision) {
    return {
      ok: false,
      error: { code: 'revision_changed', message: `Catalog revision changed from ${params.pinRevision} to ${params.currentRevision}` },
      durationMs: Date.now() - start,
      revisionAtCall: params.currentRevision,
    };
  }

  // Check external call guard
  if (params.tool.sideEffectClass === 'external' && !params.allowExternal) {
    return {
      ok: false,
      error: { code: 'external_blocked', message: 'This tool touches an external service. Pass allowExternal: true to proceed.' },
      durationMs: Date.now() - start,
      revisionAtCall: params.currentRevision,
    };
  }

  // Get session
  let session = await params.roleMutex.ensureSession(params.role);
  const roleConfig = params.roleMutex['roles']?.find((r: { name: string }) => r.name === params.role);
  const roleCredentials = roleConfig?.credentials ?? {};

  const url = `${params.baseUrl.replace(/\/$/, '')}${params.tool.path}`;
  const method = params.tool.method;

  const makeRequest = async (sess: typeof session): Promise<SurfaceCallResult> => {
    const headers = buildHeaders(params.auth, sess, roleCredentials, params.projectName);

    let fetchBody: string | undefined;
    let fetchUrl = url;

    if (['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(method)) {
      // Append query params for GET-like methods
      if (Object.keys(params.input).length > 0) {
        const qp = new URLSearchParams(
          Object.fromEntries(
            Object.entries(params.input).map(([k, v]) => [k, String(v)])
          )
        );
        fetchUrl = `${url}?${qp.toString()}`;
      }
    } else {
      fetchBody = JSON.stringify(params.input);
    }

    const timeoutMs = params.timeoutMs ?? 30_000;
    let response: Response;

    try {
      response = await fetch(fetchUrl, {
        method,
        headers,
        body: fetchBody,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return {
        ok: false,
        error: { code: 'fetch_error', message: String(err) },
        durationMs: Date.now() - start,
        revisionAtCall: params.currentRevision,
      };
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const { body, truncated } = await readBodyWithLimit(response, STREAM_TIMEOUT_MS);

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: responseHeaders,
      body,
      bodyTruncated: truncated || undefined,
      durationMs: Date.now() - start,
      revisionAtCall: params.currentRevision,
    };
  };

  const result = await makeRequest(session);

  // Auto-relogin check
  if (
    !params.noAutoRelogin &&
    result.status !== undefined &&
    result.headers !== undefined
  ) {
    const cookieName =
      params.auth.kind === 'nextauth'
        ? params.auth.cookieName ?? 'next-auth.session-token'
        : 'session';

    if (shouldAutoRelogin(result.status, result.headers, result.body, cookieName)) {
      log.info({ role: params.role, status: result.status }, 'auto-relogin triggered');
      try {
        session = await params.roleMutex.refresh(params.role);
        return makeRequest(session);
      } catch (err) {
        return {
          ...result,
          ok: false,
          error: { code: 'relogin_failed', message: String(err) },
        };
      }
    }
  }

  return result;
}

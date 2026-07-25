import type { ToolMeta, SurfaceCallResult, AuthConfig } from '../types.js';
import type { RoleMutex } from '../auth/role-mutex.js';
import { shouldAutoRelogin } from '../auth/refresh-policy.js';
import { getApiKey } from '../auth/api-key.js';
import { oauth2AuthorizationHeader } from '../auth/oauth2.js';
import { resolveCredentials } from '../env/indirection.js';
import { substitutePathParams } from './path-params.js';
import { isReadOnlyBlocked, redactHeaders, type CallLimiter } from './rails.js';
import { buildGraphqlBody } from './graphql-request.js';
import { buildTrpcRequest } from './trpc-request.js';
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
  /** #181: caller-supplied cookie to merge into the Cookie header (overrides nothing; appended). */
  extraCookie?: string;
  /** Rails: refuse any tool that isn't `safe` (no mutating/external calls). */
  readOnly?: boolean;
  /** Rails: build the request and return it WITHOUT sending. Secrets are masked. */
  dryRun?: boolean;
  /** Rails: per-surface rate/concurrency limiter. Omitted = unbounded. */
  limiter?: CallLimiter;
  /** Coverage/telemetry sink. Called with the final result; must never throw. */
  observer?: { record: (tool: ToolMeta, result: SurfaceCallResult) => void };
};

function buildHeaders(
  auth: AuthConfig,
  session: { cookies?: string[]; token?: string; tokenType?: string } | undefined,
  roleCredentials: Record<string, string>,
  projectName: string,
  extraCookie?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Surface-Origin': `surfacemcp/${projectName}`,
  };

  const sessionCookies: string[] = [];

  if (session) {
    switch (auth.kind) {
      case 'form':
      case 'nextauth':
        if (session.cookies && session.cookies.length > 0) {
          sessionCookies.push(...session.cookies.map((c) => c.split(';')[0]));
        }
        break;
      case 'bearer':
        if (session.token) {
          headers['Authorization'] = `Bearer ${session.token}`;
        }
        break;
      case 'oauth2':
        // Access token minted by the token endpoint; `token_type` is honored when
        // the authorization server returned something other than Bearer.
        if (session.token) {
          headers['Authorization'] = oauth2AuthorizationHeader(session.token, session.tokenType);
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
  }

  // #181: merge caller-supplied extraCookie (from BugHunter's cookie_endpoint login path)
  // with any session cookies so both reach the backend.
  if (extraCookie !== undefined && extraCookie !== '') {
    sessionCookies.push(extraCookie);
  }

  if (sessionCookies.length > 0) {
    headers['Cookie'] = sessionCookies.join('; ');
  }

  return headers;
}

/**
 * #leak: drop `set-cookie` from headers returned to the caller so a freshly
 * minted target session is never handed back over the MCP wire. The auth-refresh
 * decision that needs `set-cookie` runs before this strip is applied.
 */
function stripSetCookie(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'set-cookie') continue;
    out[k] = v;
  }
  return out;
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

      // Race the read against a deadline. Use a distinct 'timeout' sentinel (not a
      // fabricated {done:true}) so a timed-out read is reported as truncated, not
      // as a complete body — and clear the timer each iteration so it can't leak
      // or keep the event loop alive after the chunk arrives.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), remaining);
      });
      const result = await Promise.race([reader.read(), timeoutPromise]);
      clearTimeout(timer);

      if (result === 'timeout') {
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
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

/**
 * Execute a discovered tool. Thin wrapper so coverage observation happens on
 * every return path (guards, dry runs, failures, successes) in one place.
 */
export async function executeCall(params: CallParams): Promise<SurfaceCallResult> {
  const result = await executeCallInner(params);
  params.observer?.record(params.tool, result);
  return result;
}

async function executeCallInner(params: CallParams): Promise<SurfaceCallResult> {
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

  // Rails: read-only mode refuses anything that isn't `safe`. Checked before the
  // external guard so a read-only caller gets the clearer refusal, and before any
  // session/login work so a blocked call has zero side effects.
  if (isReadOnlyBlocked(params.tool, params.readOnly === true)) {
    return {
      ok: false,
      error: {
        code: 'read_only_blocked',
        message: `Read-only mode: refusing '${params.tool.sideEffectClass}' tool ${params.tool.name}. Only 'safe' tools may be called.`,
      },
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

  // Substitute :id / {id} / <int:pk> path params from input into the URL, then
  // strip the consumed keys so they aren't also sent as query/body.
  const sub = substitutePathParams(params.tool.path, params.input);
  if (!sub.ok) {
    return {
      ok: false,
      error: {
        code: 'missing_path_param',
        message: `Missing required path parameter(s): ${sub.missing.join(', ')}`,
      },
      durationMs: Date.now() - start,
      revisionAtCall: params.currentRevision,
    };
  }
  const url = `${params.baseUrl.replace(/\/$/, '')}${sub.path}`;
  const bodyInput = sub.consumed.size
    ? Object.fromEntries(Object.entries(params.input).filter(([k]) => !sub.consumed.has(k)))
    : params.input;
  const method = params.tool.method;

  const makeRequest = async (sess: typeof session): Promise<SurfaceCallResult> => {
    const headers = buildHeaders(params.auth, sess, roleCredentials, params.projectName, params.extraCookie);

    let fetchBody: string | undefined;
    let fetchUrl = url;

    if (params.tool.graphql) {
      // GraphQL: the operation lives in the POST body as `{ query, variables }`, not
      // in the URL. Always POST to the endpoint path; the caller's input is variables.
      // Guarded strictly on `tool.graphql` so REST tools are unaffected.
      //
      // #gql-injection: buildGraphqlBody re-validates every descriptor fragment it
      // concatenates and throws rather than emitting a spliced operation. Fail the
      // call here instead of letting it escape as an unhandled rejection.
      try {
        fetchBody = buildGraphqlBody(params.tool.graphql, params.input);
      } catch (err) {
        return {
          ok: false,
          error: { code: 'bad_graphql_descriptor', message: String(err) },
          durationMs: Date.now() - start,
          revisionAtCall: params.currentRevision,
        };
      }
    } else if (params.tool.trpc) {
      // tRPC: procedures share one mount point and are addressed by dotted path;
      // a query carries its input in the `input` query param, a mutation in the JSON
      // body. Guarded strictly on `tool.trpc` so REST and GraphQL are unaffected.
      const trpcRequest = buildTrpcRequest(params.tool.trpc, url, params.input);
      fetchUrl = trpcRequest.url;
      fetchBody = trpcRequest.body;
    } else if (['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(method)) {
      // Append query params for GET-like methods
      if (Object.keys(bodyInput).length > 0) {
        const qp = new URLSearchParams(
          Object.fromEntries(
            Object.entries(bodyInput).map(([k, v]) => [
              k,
              // Objects/arrays would stringify to "[object Object]"; JSON-encode them.
              v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v),
            ])
          )
        );
        fetchUrl = `${url}?${qp.toString()}`;
      }
    } else {
      fetchBody = JSON.stringify(bodyInput);
    }

    // Rails: dryRun returns the fully-resolved request without issuing it. Placed
    // after URL/body/header construction so the preview is exactly what would go
    // out, and before any network work so it has zero side effects. Credential
    // header values are masked — the caller sees that auth would be attached, but
    // never the secret.
    if (params.dryRun) {
      return {
        ok: true,
        dryRun: {
          method,
          url: fetchUrl,
          headers: redactHeaders(headers),
          ...(fetchBody === undefined ? {} : { body: fetchBody }),
        },
        durationMs: Date.now() - start,
        revisionAtCall: params.currentRevision,
      };
    }

    const timeoutMs = params.timeoutMs ?? 30_000;
    let response: Response;

    // Rails: hold a rate/concurrency slot for the whole request — including the
    // body read — so `maxConcurrent` genuinely bounds in-flight load on the
    // target rather than only the header round-trip.
    const release = params.limiter ? await params.limiter.acquire() : undefined;
    try {
      try {
        response = await fetch(fetchUrl, {
          method,
          headers,
          body: fetchBody,
          // #SSRF: never silently follow redirects — a 3xx to an attacker-controlled
          // host would let the target pivot our authenticated session elsewhere.
          // Surface the 3xx status + Location header to the caller instead.
          redirect: 'manual',
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
    } finally {
      release?.();
    }
  };

  let result = await makeRequest(session);

  // Auto-relogin check. This reads result.headers['set-cookie'], so it must run
  // BEFORE we strip set-cookie from the caller-facing headers below.
  if (
    !params.noAutoRelogin &&
    result.status !== undefined &&
    result.headers !== undefined
  ) {
    const cookieName =
      params.auth.kind === 'nextauth'
        ? params.auth.cookieName ?? 'next-auth.session-token'
        : 'session';

    if (shouldAutoRelogin(result.status, result.headers, result.body, cookieName, params.auth.kind)) {
      log.info({ role: params.role, status: result.status }, 'auto-relogin triggered');
      try {
        session = await params.roleMutex.refresh(params.role);
        result = await makeRequest(session);
      } catch (err) {
        result = {
          ...result,
          ok: false,
          error: { code: 'relogin_failed', message: String(err) },
        };
      }
    }
  }

  // #leak: never return the target's Set-Cookie to the caller.
  if (result.headers !== undefined) {
    result = { ...result, headers: stripSetCookie(result.headers) };
  }

  return result;
}

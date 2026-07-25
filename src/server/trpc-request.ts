import type { TrpcToolDescriptor } from '../types.js';

export type TrpcRequest = {
  /** Fully-qualified URL to fetch. */
  url: string;
  /** JSON request body; absent for queries and for input-less mutations. */
  body?: string;
};

/**
 * Build the HTTP request for a tRPC procedure call.
 *
 * tRPC's HTTP protocol addresses a procedure by appending its dotted path to the
 * mount point, and carries the input as JSON:
 *
 *   query    → `GET  <endpoint>/<dotted.path>?input=<url-encoded JSON>`
 *   mutation → `POST <endpoint>/<dotted.path>` with the JSON input as the body
 *
 * The caller's `input` object IS the procedure input (it maps 1:1 onto the
 * `.input(z.object({…}))` schema we published), so it is sent verbatim.
 *
 * Batching (`?batch=1` with an index-keyed envelope) is intentionally not used: the
 * single-call form is the simpler wire shape, every tRPC HTTP adapter accepts it, and
 * one MCP tool call is exactly one procedure call so batching buys nothing here.
 *
 * An empty input omits the `input` parameter / body entirely rather than sending `{}`,
 * which is how a no-input procedure is invoked.
 */
export function buildTrpcRequest(
  desc: TrpcToolDescriptor,
  endpointUrl: string,
  input: Record<string, unknown> | undefined
): TrpcRequest {
  const url = `${endpointUrl.replace(/\/+$/, '')}/${desc.procedurePath}`;
  const hasInput = input !== undefined && input !== null && Object.keys(input).length > 0;

  if (desc.procedureType === 'query') {
    return hasInput ? { url: `${url}?input=${encodeURIComponent(JSON.stringify(input))}` } : { url };
  }
  return hasInput ? { url, body: JSON.stringify(input) } : { url };
}

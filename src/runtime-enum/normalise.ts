// Path normalisation for runtime-enumerated routes.
// Converts router-specific param syntax to react-router-v6 style.

/**
 * Normalise a router path from any detected format to react-router-v6 syntax.
 *
 * Rules:
 * - $param → :param (TanStack)
 * - $splat → * (TanStack wildcard)
 * - trailing slash stripped (except root '/')
 * - leading double slashes collapsed to /
 * - query string stripped
 * - hash stripped
 * - empty string → '/'
 */
export function normaliseRoutePath(path: string): string {
  if (!path) return '/';

  // Strip query and hash
  const qIdx = path.indexOf('?');
  if (qIdx !== -1) path = path.slice(0, qIdx);
  const hIdx = path.indexOf('#');
  if (hIdx !== -1) path = path.slice(0, hIdx);

  // TanStack $splat → *
  path = path.replace(/\$splat\b/g, '*');

  // TanStack $param → :param
  path = path.replace(/\$([A-Za-z_][\w]*)/g, ':$1');

  // Collapse leading double slashes
  path = path.replace(/^\/\/+/, '/');

  // Strip trailing slash (except root)
  if (path !== '/' && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path || '/';
}

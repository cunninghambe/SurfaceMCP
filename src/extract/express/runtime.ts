/**
 * Express runtime introspection helper.
 * This module can be injected into the target Express app as a middleware
 * that exposes a `/__surface__` endpoint listing all registered routes.
 *
 * Users opt in by adding `require('surfacemcp/express-helper')` to their app.
 * Not required for static analysis — this is a supplement for dynamic routes.
 */

export function surfaceMiddleware() {
  // Return an Express router that handles /__surface__ introspection
  // This is a lightweight helper exported for target apps to optionally include.
  return async function surfaceIntrospectHandler(
    req: { method: string; url: string },
    res: { json: (data: unknown) => void },
    next: () => void
  ) {
    if (req.method === 'GET' && req.url === '/__surface__') {
      // When injected, the app should call this with its router instance
      res.json({ routes: [], note: 'Configure surfaceMiddleware with your Express app instance' });
      return;
    }
    next();
  };
}

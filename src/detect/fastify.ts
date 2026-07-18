import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';

function hasFastifyInDeps(root: string): boolean {
  const pkgPath = resolve(root, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as unknown;
    if (pkg === null || typeof pkg !== 'object') return false;
    const p = pkg as Record<string, unknown>;
    const deps = {
      ...(p.dependencies as Record<string, unknown> | undefined ?? {}),
      ...(p.devDependencies as Record<string, unknown> | undefined ?? {}),
    };
    return 'fastify' in deps;
  } catch {
    return false;
  }
}

/**
 * Fastify-specific source signals. Keys on the `fastify` import/require or the
 * `FastifyInstance` plugin type — NOT bare `.get/.post`, which Express shares.
 * A route registration only counts once a Fastify marker is also present, so an
 * Express app that happens to list `fastify` transitively can't false-positive.
 */
function hasFastifyRoutes(root: string): boolean {
  const candidates = [
    resolve(root, 'src/app.ts'),
    resolve(root, 'src/app.js'),
    resolve(root, 'src/index.ts'),
    resolve(root, 'src/index.js'),
    resolve(root, 'src/server.ts'),
    resolve(root, 'src/server.js'),
    resolve(root, 'app.ts'),
    resolve(root, 'app.js'),
    resolve(root, 'index.ts'),
    resolve(root, 'index.js'),
    resolve(root, 'server.ts'),
    resolve(root, 'server.js'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const project = new Project({ useInMemoryFileSystem: false });
      const sf = project.addSourceFileAtPath(candidate);
      const text = sf.getFullText();
      // Fastify markers: import/require of 'fastify', or a plugin typed FastifyInstance.
      if (/from\s+['"]fastify['"]/.test(text)) return true;
      if (/require\(\s*['"]fastify['"]\s*\)/.test(text)) return true;
      if (/\bFastifyInstance\b/.test(text)) return true;
      // Route registrations (get/post/.../route). Only reached when the file has
      // no explicit Fastify marker; the deps gate keeps this from matching Express.
      const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expr = call.getExpression().getText();
        if (/\.(get|post|put|delete|patch|head|options|route)\b/.test(expr)) return true;
      }
    } catch {
      // fall back to text search
      try {
        const text = readFileSync(candidate, 'utf-8');
        if (
          /from\s+['"]fastify['"]|require\(\s*['"]fastify['"]\s*\)|\bFastifyInstance\b|\.(get|post|put|delete|patch|head|options|route)\s*\(/.test(
            text
          )
        ) {
          return true;
        }
      } catch {
        // skip
      }
    }
  }
  return false;
}

export function isFastify(root: string): boolean {
  return hasFastifyInDeps(root) && hasFastifyRoutes(root);
}

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './types.js';
import { log } from './log.js';

const SuccessCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('redirect'), to: z.string() }),
  z.object({ kind: z.literal('cookie'), name: z.string() }),
  z.object({ kind: z.literal('status'), code: z.number().int() }),
  // v0.18: JWT-bearer SPA support
  z.object({
    kind: z.literal('localStorage'),
    key: z.string(),
    tokenJsonPath: z.string().optional(),
    minLength: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('dom_signal'),
    selector: z.string(),
  }),
]);

const PreLoginSchema = z.object({
  method: z.enum(['GET', 'POST']),
  path: z.string(),
  captureBodyFieldAs: z.string().optional(),
  captureBodyRegex: z.string().optional(),
  captureCookieAs: z.string().optional(),
});

const AuthConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('form'),
    preLogin: PreLoginSchema.optional(),
    loginMethod: z.enum(['POST', 'GET']),
    loginPath: z.string(),
    loginFields: z.record(z.string()),
    /** Encoding for the request body. Defaults to 'form' (application/x-www-form-urlencoded).
     * Use 'json' for SaaS apps whose login endpoints expect a JSON payload. */
    bodyFormat: z.enum(['form', 'json']).optional(),
    successCheck: SuccessCheckSchema,
    uiLoginPath: z.string().optional(),
    uiLoginFields: z.record(z.string()).optional(),
    uiTriggerSelector: z.string().optional(),
    uiSubmitSelector: z.string().optional(),
  }),
  z.object({
    kind: z.literal('nextauth'),
    csrfPath: z.string().optional(),
    callbackPath: z.string().optional(),
    cookieName: z.string().optional(),
    fields: z.record(z.string()),
    callbackUrl: z.string().optional(),
    uiLoginPath: z.string().optional(),
    uiLoginFields: z.record(z.string()).optional(),
    uiTriggerSelector: z.string().optional(),
    uiSubmitSelector: z.string().optional(),
  }),
  z.object({ kind: z.literal('bearer') }),
  z.object({
    kind: z.literal('api_key'),
    header: z.string().optional(),
    query: z.string().optional(),
  }),
]);

const RoleConfigSchema = z.object({
  name: z.string().min(1),
  credentials: z.record(z.string()).optional(),
});

const SurfaceConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, {
      message:
        'Surface name must contain only [a-zA-Z0-9_-]. Reserved characters ":" and "." are not allowed because they are used in tool naming.',
    }),
  stack: z.enum(['nextjs', 'express', 'fastify', 'fastapi', 'django', 'openapi', 'vite']),
  root: z.string(),
  baseUrl: z.string().url(),
  port: z.number().int().min(3102).max(3199),
  launchDevCommand: z.string().optional(),
  watchPaths: z.array(z.string()).optional(),
  watchIgnore: z.array(z.string()).optional(),
  auth: AuthConfigSchema,
  roles: z.array(RoleConfigSchema),
  schemaIntrospection: z
    .object({
      zodAlias: z.string().optional(),
      pydanticBaseClass: z.string().optional(),
      // Express body-validator function names to treat as schema sources. Was
      // present in the TS type + consumed at tools-meta, but missing here, so
      // .parse() silently dropped it. Keep in sync with SurfaceConfig in types.ts.
      bodyValidatorNames: z.array(z.string()).optional(),
    })
    .optional(),
  excludedRoutes: z.array(z.string()).optional(),
  externalIntegrations: z.array(z.string()).optional(),
  _suggestedExternalIntegrations: z.array(z.string()).optional(),
});

const ConfigSchema = z
  .object({
    surfaces: z.array(SurfaceConfigSchema).min(1),
    /** Optional: explicit MCP listen port. When unset, surfaces[0].port is used. */
    mcpPort: z.number().int().min(3102).max(3199).optional(),
  })
  .superRefine((cfg, ctx) => {
    const names = cfg.surfaces.map((s) => s.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['surfaces'],
        message: `Duplicate surface name: "${dup}". Surface names must be unique.`,
      });
    }
  });

/**
 * Find every role credential whose value is an inline literal rather than a
 * `$env:VAR` indirection. Literals in a committed config file are a secret-leak
 * risk; secrets belong in a gitignored env file. Returns human-readable paths
 * like `surfaces[0].roles[1].credentials.password`.
 */
export function findLiteralCredentialPaths(config: Config): string[] {
  const paths: string[] = [];
  config.surfaces.forEach((surface, si) => {
    surface.roles.forEach((role, ri) => {
      if (!role.credentials) return;
      for (const [key, value] of Object.entries(role.credentials)) {
        if (!value.startsWith('$env:')) {
          paths.push(`surfaces[${si}].roles[${ri}].credentials.${key}`);
        }
      }
    });
  });
  return paths;
}

/**
 * JSON Schema (Draft 2020-12) for `surfacemcp.config.json`, generated from the
 * Zod schema so it can never drift. Emit it with `surfacemcp schema` and add a
 * `"$schema"` reference to your config for editor autocomplete + validation.
 */
export function configJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(ConfigSchema, {
    name: 'SurfaceMcpConfig',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}. Run \`surfacemcp init\` first.`);
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
  const config = ConfigSchema.parse(raw);

  const literals = findLiteralCredentialPaths(config);
  if (literals.length > 0) {
    log.warn(
      { literalCredentials: literals },
      `Config has ${literals.length} literal credential value(s) not using $env: indirection. Move secrets to a gitignored .env.local and reference them as $env:VAR.`
    );
  }

  return config;
}

export function findConfigPath(projectRoot: string): string {
  return resolve(projectRoot, 'surfacemcp.config.json');
}

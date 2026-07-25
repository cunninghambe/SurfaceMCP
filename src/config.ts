import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
  // OAuth2 / OIDC client-credentials grant (RFC 6749 §4.4) — the machine-to-machine
  // grant that fits SurfaceMCP's non-interactive model. NOTE: this block carries no
  // secrets. `client_id`/`client_secret` come from the role's `credentials` map via
  // `$env:` indirection, exactly like every other auth kind.
  z.object({
    kind: z.literal('oauth2'),
    /** Absolute token endpoint URL, e.g. https://auth.example.com/oauth2/token.
     * Restricted to http(s) with no embedded userinfo: the client secret is
     * POSTed here, so no other scheme (file:, data:, …) may be dialled, and
     * credentials must come from the role's `credentials` map — never a URL. */
    tokenUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), { message: 'tokenUrl must be an http(s) URL' })
      .refine(
        (u) => {
          try {
            const parsed = new URL(u);
            return parsed.username === '' && parsed.password === '';
          } catch {
            return false;
          }
        },
        { message: 'tokenUrl must not embed credentials (user:password@); use roles[].credentials' }
      ),
    /** Only the client-credentials grant is supported. Defaults to 'client_credentials'. */
    grantType: z.enum(['client_credentials']).optional(),
    /** Space-delimited scopes requested in the token request. */
    scope: z.string().optional(),
    /** `audience` form parameter (Auth0/Okta-style resource selector). */
    audience: z.string().optional(),
    /** How the client credentials are presented. Defaults to 'basic' (RFC 6749 §2.3.1
     * prefers HTTP Basic); 'body' sends client_id/client_secret as form fields. */
    clientAuth: z.enum(['basic', 'body']).optional(),
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
  stack: z.enum(['nextjs', 'express', 'fastify', 'nestjs', 'fastapi', 'django', 'openapi', 'vite', 'graphql']),
  root: z.string(),
  baseUrl: z.string().url(),
  port: z.number().int().min(3102).max(3199),
  /** GraphQL endpoint path (graphql stack only). Defaults to '/graphql' when unset. */
  graphqlPath: z.string().optional(),
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
      /**
       * #target-code-exec: when resolving a zod schema, the Next.js/Express
       * extractors may `await import(...)` a file from the TARGET project, which
       * EXECUTES that project's code inside the SurfaceMCP process (at every
       * extraction and every file-watcher regen). Imports are confined to the
       * surface root, but this is not a sandbox. Default `true` (unchanged
       * behaviour); set `false` to fall back to static AST parsing only, which may
       * lower `inputSchemaConfidence` for schemas resolved through a re-export.
       */
      dynamicImport: z.boolean().optional(),
    })
    .optional(),
  excludedRoutes: z.array(z.string()).optional(),
  externalIntegrations: z.array(z.string()).optional(),
  _suggestedExternalIntegrations: z.array(z.string()).optional(),
  /**
   * Safety rails for autonomous callers. All optional; omitted = current
   * behaviour (no read-only restriction, unbounded rate/concurrency).
   */
  rails: z
    .object({
      /** Refuse every non-`safe` tool on this surface (callers cannot override). */
      readOnly: z.boolean().optional(),
      /** Max requests started per second against the target. */
      requestsPerSecond: z.number().positive().optional(),
      /** Max requests in flight against the target at once. */
      maxConcurrent: z.number().int().positive().optional(),
    })
    .optional(),
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

// The config types are INFERRED from the Zod schemas above, making the schema the
// single source of truth. A field present in a type but missing from its schema
// (the `bodyValidatorNames` drift) is now structurally impossible. types.ts
// re-exports these.
export type SuccessCheck = z.infer<typeof SuccessCheckSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type SurfaceConfig = z.infer<typeof SurfaceConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Find every role credential whose value is an inline literal rather than a
 * `$env:VAR` indirection. Literals in a committed config file are a secret-leak
 * risk; secrets belong in a gitignored env file. Returns human-readable paths
 * like `surfaces[0].roles[1].credentials.password`.
 *
 * Auth-kind agnostic by construction: every kind sources its secrets from
 * `roles[].credentials` (form/nextauth passwords, `token`, `api_key`, and the
 * oauth2 `client_secret`), so a new auth kind is covered without changes here.
 * Auth blocks themselves never hold secrets.
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

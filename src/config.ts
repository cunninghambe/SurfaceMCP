import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './types.js';

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
  name: z.string().min(1),
  stack: z.enum(['nextjs', 'express', 'fastapi', 'django', 'openapi', 'vite']),
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
    })
    .optional(),
  excludedRoutes: z.array(z.string()).optional(),
  externalIntegrations: z.array(z.string()).optional(),
  _suggestedExternalIntegrations: z.array(z.string()).optional(),
});

const ConfigSchema = z.object({
  surfaces: z.array(SurfaceConfigSchema).min(1),
});

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}. Run \`surfacemcp init\` first.`);
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
  return ConfigSchema.parse(raw);
}

export function findConfigPath(projectRoot: string): string {
  return resolve(projectRoot, 'surfacemcp.config.json');
}

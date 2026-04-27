/** Draft 2020-12 JSON Schema (minimal typing for our purposes) */
export type JsonSchema2020 = {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema2020>;
  required?: string[];
  items?: JsonSchema2020;
  additionalProperties?: boolean | JsonSchema2020;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  pattern?: string;
  description?: string;
  default?: unknown;
  $ref?: string;
  anyOf?: JsonSchema2020[];
  oneOf?: JsonSchema2020[];
  allOf?: JsonSchema2020[];
  not?: JsonSchema2020;
  [key: string]: unknown;
};

export type InputSchemaConfidence = 'introspected' | 'inferred' | 'partial' | 'unknown';
export type SideEffectClass = 'safe' | 'mutating' | 'external';

export type ToolMeta = {
  name: string;
  toolId: string;
  method: string;
  path: string;
  inputSchema: JsonSchema2020;
  inputSchemaConfidence: InputSchemaConfidence;
  outputSchema?: JsonSchema2020;
  sideEffectClass: SideEffectClass;
  sourceFile: string;
  sourceLine: number;
  sourceFunctionName?: string;
  isServerAction: boolean;
};

export type ToolCatalog = {
  revision: number;
  tools: ToolMeta[];
};

export type Stack = 'nextjs' | 'express' | 'fastapi' | 'django' | 'openapi';

export type AuthConfig =
  | { kind: 'none' }
  | {
      kind: 'form';
      preLogin?: {
        method: 'GET' | 'POST';
        path: string;
        captureBodyFieldAs?: string;
        captureBodyRegex?: string;
        captureCookieAs?: string;
      };
      loginMethod: 'POST' | 'GET';
      loginPath: string;
      loginFields: Record<string, string>;
      bodyFormat?: 'form' | 'json';
      successCheck: SuccessCheck;
    }
  | {
      kind: 'nextauth';
      csrfPath?: string;
      callbackPath?: string;
      cookieName?: string;
      fields: Record<string, string>;
      callbackUrl?: string;
    }
  | { kind: 'bearer' }
  | { kind: 'api_key'; header?: string; query?: string };

export type SuccessCheck =
  | { kind: 'redirect'; to: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'status'; code: number };

export type RoleConfig = {
  name: string;
  /** Optional. A role without credentials is anonymous: no login flow, requests go unauthenticated. */
  credentials?: Record<string, string>;
};

export type SurfaceConfig = {
  name: string;
  stack: Stack;
  root: string;
  baseUrl: string;
  port: number;
  launchDevCommand?: string;
  watchPaths?: string[];
  watchIgnore?: string[];
  auth: AuthConfig;
  roles: RoleConfig[];
  schemaIntrospection?: {
    zodAlias?: string;
    pydanticBaseClass?: string;
  };
  excludedRoutes?: string[];
  externalIntegrations?: string[];
  _suggestedExternalIntegrations?: string[];
};

export type Config = {
  surfaces: SurfaceConfig[];
};

/** Stored session state per role */
export type RoleSession = {
  cookies: string[];
  token?: string;
  cachedAt: string;
  lastRefreshAt?: string;
  refreshCount: number;
};

export type SurfaceCallResult = {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  bodyTruncated?: boolean;
  error?: { code: string; message: string };
  durationMs: number;
  revisionAtCall: number;
};

export type ProbeResult = {
  recoveredSchema?: JsonSchema2020;
  confidence: 'inferred' | 'unknown';
  rawError?: unknown;
};

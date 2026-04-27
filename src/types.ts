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

export type Stack = 'nextjs' | 'express' | 'fastapi' | 'django' | 'openapi' | 'vite';

export type PageSource = 'static' | 'crawl_seed';

export type Page = {
  /**
   * URL path as authored (e.g. '/', '/admin/users', '/users/:id').
   * Case-preserved; param tokens use `:name` syntax (react-router style).
   */
  route: string;
  /**
   * Project-root-relative path to the source file declaring the component.
   * Posix separators. Example: 'src/pages/Home.tsx'.
   * Set to '<unresolved>' if the import could not be resolved.
   */
  sourceFile: string;
  /**
   * The component identifier as it appeared in the JSX `element={...}` slot,
   * or the lazy-binding name. Optional because future stacks may not have a name.
   */
  componentName?: string;
  /** True when the component was loaded via `React.lazy(() => import(...))`. */
  lazy: boolean;
  /**
   * Names of dynamic params extracted from the route, in order.
   * '/users/:id' → ['id']. Splat ('*') becomes the synthetic name '*'.
   */
  dynamicParams: string[];
  /**
   * Source file + line where the `<Route>` (or createBrowserRouter object) was declared.
   * Project-root-relative.
   */
  declaredAt: { file: string; line: number };
  /**
   * How this page entry was produced.
   * - 'static': extracted from source code (default; backward-compatible).
   * - 'crawl_seed': emitted as a starting URL for runtime crawl-based discovery.
   *   Consumer (e.g. BugHunter) is expected to navigate the route, walk the DOM,
   *   follow same-origin links, and recursively discover more pages.
   * Optional for backward-compat: missing/undefined ≡ 'static'.
   */
  source?: PageSource;
};

export type PageCatalog = {
  revision: number;
  pages: Page[];
  skips: PageSkip[];
};

export type PageSkip = {
  /** Best-effort route or component name; '<unknown>' when neither is known. */
  route: string;
  reason:
    | 'dynamic_path'
    | 'dynamic_route_array'
    | 'unsupported_router_arg'
    | 'duplicate_route'
    | 'unresolved_component'
    | 'unresolved_lazy_import'
    | 'tab_state_routing_suspected'
    | 'crawl_seed_emitted';
  detail?: string;
  declaredAt?: { file: string; line: number };
};

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
      /** UI route to navigate for in-browser login. Defaults to loginPath. */
      uiLoginPath?: string;
      /** DOM field-name overrides for UI login. Maps credentialKey -> domFieldName. Defaults to loginFields. */
      uiLoginFields?: Record<string, string>;
      /** CSS selector to click before the login form appears (e.g. a modal trigger). */
      uiTriggerSelector?: string;
      /** CSS selector for the submit button. Falls back to text-based discovery when unset. */
      uiSubmitSelector?: string;
    }
  | {
      kind: 'nextauth';
      csrfPath?: string;
      callbackPath?: string;
      cookieName?: string;
      fields: Record<string, string>;
      callbackUrl?: string;
      /** UI route to navigate for in-browser login. Defaults to '/api/auth/signin'. */
      uiLoginPath?: string;
      /** DOM field-name overrides for UI login. Maps credentialKey -> domFieldName. Defaults to inverted fields. */
      uiLoginFields?: Record<string, string>;
      /** CSS selector to click before the login form appears. */
      uiTriggerSelector?: string;
      /** CSS selector for the submit button. Falls back to text-based discovery when unset. */
      uiSubmitSelector?: string;
    }
  | { kind: 'bearer' }
  | { kind: 'api_key'; header?: string; query?: string };

export type DescribeAuthResult =
  | { authKind: 'none'; reason: 'no_auth_configured' }
  | { authKind: 'bearer'; reason: 'programmatic_only'; detail: string }
  | { authKind: 'api_key'; reason: 'programmatic_only'; detail: string }
  | { authKind: 'anonymous'; reason: 'role_has_no_credentials' }
  | {
      authKind: 'form';
      uiLoginPath: string;
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
      fields: Record<string, string>;
      values: Record<string, string>;
      successCheck: SuccessCheck;
      cookieName?: string;
    }
  | {
      authKind: 'nextauth';
      uiLoginPath: string;
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
      fields: Record<string, string>;
      values: Record<string, string>;
      successCheck: SuccessCheck;
      cookieName: string;
    };

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
    bodyValidatorNames?: string[];
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

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

/**
 * Raw tool metadata as produced by per-stack extractors.
 * Does not include surface-level fields populated by tools-meta.
 */
export type RawToolMeta = {
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

export type ToolMeta = RawToolMeta & {
  /** Wire name: `<surface>:<bareName>` in multi-surface configs; bare name in single-surface configs. */
  name: string;
  /** Bare name as produced by the per-stack extractor, never prefixed. */
  bareName: string;
  /** Owning surface name. */
  surface: string;
};

export type ToolCatalog = {
  revision: number;
  tools: ToolMeta[];
};

export type Stack = 'nextjs' | 'express' | 'fastify' | 'fastapi' | 'django' | 'openapi' | 'vite';

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

/**
 * Non-secret shape metadata for a single credential field. Reports whether a
 * value is present, its length, and where it comes from — never the value itself.
 */
export type CredentialFieldMeta = {
  /** True when a non-empty resolved value exists. */
  present: boolean;
  /** Character length of the resolved value (0 when missing/empty). */
  length: number;
  /**
   * Provenance of the raw config value:
   * - 'env': sourced via `$env:VAR` indirection.
   * - 'literal': an inline literal in the config (discouraged).
   * - 'missing': the credential key is absent from the role's credentials.
   */
  source: 'env' | 'literal' | 'missing';
};

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
      /** Per-field shape metadata, keyed by domFieldName. Always present (never secret). */
      valueMeta: Record<string, CredentialFieldMeta>;
      /** Plaintext values keyed by domFieldName. Present ONLY when revealSecrets was requested. */
      values?: Record<string, string>;
      /** True when credential values are omitted (the default). */
      redacted: boolean;
      successCheck: SuccessCheck;
      cookieName?: string;
    }
  | {
      authKind: 'nextauth';
      uiLoginPath: string;
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
      fields: Record<string, string>;
      /** Per-field shape metadata, keyed by domFieldName. Always present (never secret). */
      valueMeta: Record<string, CredentialFieldMeta>;
      /** Plaintext values keyed by domFieldName. Present ONLY when revealSecrets was requested. */
      values?: Record<string, string>;
      /** True when credential values are omitted (the default). */
      redacted: boolean;
      successCheck: SuccessCheck;
      cookieName: string;
    };

export type SuccessCheck =
  | { kind: 'redirect'; to: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'status'; code: number }
  | { kind: 'localStorage'; key: string; tokenJsonPath?: string; minLength?: number }
  | { kind: 'dom_signal'; selector: string };

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
  /** Optional explicit MCP listen port. When unset, surfaces[0].port is used. */
  mcpPort?: number;
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

// ─── Navigation types ─────────────────────────────────────────────────────────

export type NavigationMethod =
  | 'link'           // <a href="...">
  | 'router-link'    // <Link to="..."> | <NavLink to="...">
  | 'router-push'    // useNavigate()('...') | navigate('...') | router.push('...')
  | 'state-setter';  // setTab('dashboard') with literal arg

export type NavigationKind =
  | 'url'    // target is a URL path; crawler navigates
  | 'state'  // target is a state-var value; crawler clicks the trigger
  | 'hash';  // target is a hash fragment

export type NavigationConfidence = 'high' | 'medium' | 'low';

export type Navigation = {
  /** Human-readable button/link label (best-effort: textContent of trigger element). */
  label: string;
  method: NavigationMethod;
  /** URL path for kind:'url'/'hash'; state-value for kind:'state'. Always a string literal. */
  target: string;
  kind: NavigationKind;
  /** Identifier of the state setter (e.g. 'tab', 'view', 'activeTab'). Set iff kind === 'state'. */
  stateVar?: string;
  triggerSelectorHint: {
    text?: string;
    testId?: string;
    ariaLabel?: string;
    /** title="..." attribute as a last-resort hint. */
    title?: string;
    /** The strongest available selector field. Derived; never overrides explicit values. */
    preferred?: 'testId' | 'ariaLabel' | 'text' | 'title';
  };
  sourceFile: string;          // project-root-relative
  sourceLine: number;
  confidence: NavigationConfidence;
  /** 'top-level' = reachable from any URL; 'page-local' = only after navigating to the parent page. */
  scope?: 'top-level' | 'page-local';
  /** Number of OTHER navigations in the same scope that share this text hint (case-insensitive). 0 = unique. */
  siblingNavigations?: number;
  /** Number of OTHER navigations across all files that share (method, target, kind, scope). 0 = unique. */
  duplicateCount?: number;
};

export type NavigationCatalog = {
  revision: number;
  navigations: Navigation[];
  skips: NavigationSkip[];
};

export type NavigationSkip = {
  reason:
    | 'dynamic_target'
    | 'unresolved_setter'
    | 'union_overflow'
    | 'iterable_overflow'
    | 'runtime_iterable'
    | 'runtime_index'
    | 'no_trigger_label';
  detail?: string;
  declaredAt?: { file: string; line: number };
};

// ─── Runtime route enumeration types ─────────────────────────────────────────

export type DetectedRouterName =
  | 'tanstack-router'
  | 'react-router-v6'
  | 'react-router-v5'
  | 'wouter'
  | 'vue-router'
  | 'next-router'
  | 'none';

export type RuntimeRoute = {
  /** Route path in react-router-v6 syntax: '/users/:id', '/admin/*'. */
  path: string;
  /** Param names extracted from path. */
  params: string[];
};

export type DetectedRouter = {
  name: DetectedRouterName;
  version?: string;
  routes: RuntimeRoute[];
};

export type RuntimeEnumerationError = {
  detector: DetectedRouterName;
  message: string;
};

export type RuntimeEnumerationRaw = {
  routers: DetectedRouter[];
  errors: RuntimeEnumerationError[];
  elapsedMs: number;
};

export type PostprocessedRoute = RuntimeRoute & {
  source: DetectedRouterName;
};

export type PostprocessedResult = {
  routes: PostprocessedRoute[];
  summary: {
    detectedRouters: DetectedRouterName[];
    errorCount: number;
    totalRoutes: number;
    dedupedRoutes: number;
    fellBackToNone: boolean;
  };
};

// ─── Multi-surface registry types ─────────────────────────────────────────────

export type SurfaceLifecycleState =
  | { kind: 'ready' }
  | { kind: 'extracting' }
  | { kind: 'failed'; phase: 'extract' | 'login' | 'detect'; error: string };

export type SurfaceRuntime = {
  surface: SurfaceConfig;
  resolvedRoot: string;
  state: SurfaceLifecycleState;
  catalog: ToolCatalog;
  pageCatalog: PageCatalog;
  navigationCatalog: NavigationCatalog;
  roleMutex: import('./auth/role-mutex.js').RoleMutex | undefined;
  watcher?: { close: () => Promise<void> };
};

export type SurfaceRegistry = {
  /** Keyed by surface.name */
  surfaces: Map<string, SurfaceRuntime>;
  /** Insertion order — preserves config order */
  order: string[];
};

export type ResolveError =
  | { code: 'not_found'; message: string }
  | { code: 'bare_name_ambiguous'; message: string; candidates: string[] }
  | { code: 'unknown_surface'; message: string }
  | { code: 'surface_not_ready'; message: string; surface: string; state: SurfaceLifecycleState };

export type SurfaceSummary = {
  name: string;
  stack: Stack;
  baseUrl: string;
  state: SurfaceLifecycleState;
  toolCount: number;
  pageCount: number;
  navigationCount: number;
  toolRevision: number;
  capabilities: {
    listPages: boolean;
    listNavigations: boolean;
    enumerateRoutesRuntime: boolean;
    crawlSeed: boolean;
  };
};

export type SurfaceListResponse = {
  surfaceMcpVersion: string;
  surfaces: SurfaceSummary[];
};

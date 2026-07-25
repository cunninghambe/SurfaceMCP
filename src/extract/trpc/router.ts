import { readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Project, Node, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from 'ts-morph';
import type {
  RawToolMeta,
  JsonSchema2020,
  InputSchemaConfidence,
  TrpcToolDescriptor,
} from '../../types.js';
import { tryResolveSchemaIdentifier } from '../nextjs/schemas.js';

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.surfacemcp', '.next', 'build']);

/**
 * `t.router({…})`, `router({…})`, `createTRPCRouter({…})` — the router constructors.
 * Deliberately does NOT include `createRouter`, which is Vue Router's constructor and
 * takes an object literal too; tRPC has no `createRouter({…})` form to lose.
 */
const ROUTER_CALLEE_RE = /(?:^|\.)(?:router|createTRPCRouter)$/;

/** Terminal chain call that decides the procedure kind. `subscription` is discovered then dropped. */
const PROCEDURE_TERMINALS = new Set(['query', 'mutation', 'subscription']);

/**
 * Procedure keys are interpolated into the request URL (`<trpcPath>/<dotted.path>`),
 * so only identifier-like keys are accepted. An exotic quoted key (`'a/b?x'`) is
 * skipped rather than allowed to inject path or query syntax into the call URL.
 */
const SAFE_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Guard against a pathological (or cyclic) router graph. */
const MAX_ROUTER_DEPTH = 8;

/** Procedure declares `.input(...)` but it could not be resolved to a zod object. */
function unknownSchema(): JsonSchema2020 {
  return { type: 'object', additionalProperties: true };
}

/** Procedure declares no `.input(...)` at all — statically proven to take no input. */
function noInputSchema(): JsonSchema2020 {
  return { type: 'object', properties: {}, additionalProperties: false };
}

/**
 * Operation-keyed stable id. Every tRPC tool shares the single mount path
 * (`GET|POST <trpcPath>`), so the REST `sha1(method:path)` scheme would collapse all
 * queries onto one id and all mutations onto another. Key on the procedure instead —
 * mirrors the GraphQL precedent (`sha1(graphql:<op>:<field>)`).
 */
export function computeTrpcToolId(procedureType: 'query' | 'mutation', procedurePath: string): string {
  return createHash('sha1')
    .update(`trpc:${procedureType}:${procedurePath}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * `query_post_byId` / `mutation_post_create`. Path-based `pathToToolName` can't
 * express this (all procedures share one path), so — as with GraphQL — a small local
 * helper keys the name on the operation. Dots become underscores because MCP tool
 * names may not contain `.`.
 */
export function procedureToolName(procedureType: 'query' | 'mutation', procedurePath: string): string {
  return `${procedureType}_${procedurePath.replace(/\./g, '_')}`;
}

function walkTs(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walkTs(full, files);
    } else if (
      /\.(ts|tsx|js|mjs)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.spec.')
    ) {
      files.push(full);
    }
  }
  return files;
}

function relPosix(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, '/');
}

// ─── Router / procedure recognition ───────────────────────────────────────────

/** The object-literal argument of a router constructor call, or null if this isn't one. */
function routerObjectArg(node: Node): ObjectLiteralExpression | null {
  if (!Node.isCallExpression(node)) return null;
  if (!ROUTER_CALLEE_RE.test(node.getExpression().getText())) return null;
  const arg = node.getArguments()[0];
  return arg && Node.isObjectLiteralExpression(arg) ? arg : null;
}

type RouterDecl = {
  /** Variable name the router is bound to; '' for an anonymous/inline router literal. */
  name: string;
  obj: ObjectLiteralExpression;
  /** File the literal lives in — the scope zod schema identifiers are resolved against. */
  sf: SourceFile;
  line: number;
};

type ProcedureChain = {
  procedureType: 'query' | 'mutation' | 'subscription';
  inputNode?: Node;
  outputNode?: Node;
};

/**
 * Recognize a procedure builder chain, e.g.
 * `publicProcedure.use(mw).input(Schema).output(Schema).mutation(fn)`.
 *
 * Walks the property-access chain outermost → innermost. The outermost call names the
 * procedure kind; `.input`/`.output` anywhere in the chain supply the schemas; any
 * other link (`.use`, `.meta`, `.concat`) is ignored. Returns null when the chain has
 * no `query`/`mutation`/`subscription` terminal — i.e. it isn't a procedure.
 */
function parseProcedureChain(node: Node): ProcedureChain | null {
  if (!Node.isCallExpression(node)) return null;
  let procedureType: ProcedureChain['procedureType'] | undefined;
  let inputNode: Node | undefined;
  let outputNode: Node | undefined;

  let cur: Node = node;
  while (Node.isCallExpression(cur)) {
    const callee = cur.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) break;
    const name = callee.getName();
    if (procedureType === undefined && PROCEDURE_TERMINALS.has(name)) {
      procedureType = name as ProcedureChain['procedureType'];
    } else if (name === 'input' && inputNode === undefined) {
      // tRPC merges repeated .input() calls; we take the outermost and don't merge.
      inputNode = cur.getArguments()[0];
    } else if (name === 'output' && outputNode === undefined) {
      outputNode = cur.getArguments()[0];
    }
    cur = callee.getExpression();
  }

  if (procedureType === undefined) return null;
  return { procedureType, inputNode, outputNode };
}

// ─── Router graph discovery ───────────────────────────────────────────────────

type RouterGraph = {
  /** Routers bound to a variable, keyed by that variable's name (project-wide). */
  byName: Map<string, RouterDecl>;
  /** Names used as a property VALUE inside some router literal — i.e. sub-routers. */
  referenced: Set<string>;
  /** Every router literal found, in file order. */
  all: RouterDecl[];
};

function collectRouters(sourceFiles: SourceFile[]): RouterGraph {
  const byName = new Map<string, RouterDecl>();
  const referenced = new Set<string>();
  const all: RouterDecl[] = [];

  for (const sf of sourceFiles) {
    for (const decl of sf.getVariableDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      const obj = routerObjectArg(init);
      if (!obj) continue;
      const name = decl.getName();
      // First declaration wins; files are added in sorted order, so this is deterministic.
      if (!byName.has(name)) {
        byName.set(name, { name, obj, sf, line: decl.getStartLineNumber() });
      }
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const obj = routerObjectArg(call);
      if (!obj) continue;
      all.push({ name: '', obj, sf, line: call.getStartLineNumber() });
      for (const prop of obj.getProperties()) {
        if (Node.isPropertyAssignment(prop)) {
          const value = prop.getInitializer();
          if (value && Node.isIdentifier(value)) referenced.add(value.getText());
        } else if (Node.isShorthandPropertyAssignment(prop)) {
          referenced.add(prop.getName());
        }
      }
    }
  }

  return { byName, referenced, all };
}

function byFileThenLine(a: RouterDecl, b: RouterDecl): number {
  return a.sf.getFilePath().localeCompare(b.sf.getFilePath()) || a.line - b.line;
}

/**
 * Candidate root routers — the one actually mounted at `trpcPath` — best first.
 *
 * A tRPC project declares many routers but mounts exactly one. The root is a
 * variable-bound router that is never referenced as a sub-router by another router
 * literal. `appRouter` (the near-universal convention) wins any tie; otherwise order is
 * (file, line) so the result is deterministic. When no router is bound to a variable at
 * all (`createHTTPServer({ router: router({…}) })`), fall back to the outermost router
 * literals — those not nested inside another.
 *
 * A list rather than a single pick so the caller can move on if the best candidate
 * turns out to contain no procedures at all (a same-named non-tRPC `router({…})` call).
 */
function rootRouterCandidates(graph: RouterGraph): RouterDecl[] {
  const named = [...graph.byName.values()]
    .filter((r) => !graph.referenced.has(r.name))
    .sort(byFileThenLine);
  if (named.length > 0) {
    const conventional = named.filter((r) => r.name === 'appRouter');
    return [...conventional, ...named.filter((r) => r.name !== 'appRouter')];
  }

  if (graph.all.length === 0) return [];
  const literals = new Set<Node>(graph.all.map((r) => r.obj));
  const outermost = graph.all.filter((r) => !r.obj.getAncestors().some((a) => literals.has(a)));
  return (outermost.length > 0 ? outermost : graph.all).sort(byFileThenLine);
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Resolve a `.input(...)` / `.output(...)` argument to JSON Schema via the shared
 * static zod reader (`tryResolveSchemaIdentifier`), which handles an inline
 * `z.object({…})` and a file-level `const Schema = z.object({…})` identifier. Returns
 * null when the argument doesn't resolve to a zod object.
 *
 * Deliberately static: target code is never imported or executed to read a schema.
 */
function resolveZodArg(node: Node | undefined, sf: SourceFile): JsonSchema2020 | null {
  if (!node) return null;
  const result = tryResolveSchemaIdentifier(node, sf);
  return result.confidence === 'introspected' ? result.schema : null;
}

// ─── Walk ─────────────────────────────────────────────────────────────────────

type WalkContext = {
  root: string;
  trpcPath: string;
  graph: RouterGraph;
  tools: RawToolMeta[];
  seen: Set<string>;
};

function walkRouter(
  decl: RouterDecl,
  prefix: string,
  ctx: WalkContext,
  visited: Set<string>,
  depth: number
): void {
  if (depth > MAX_ROUTER_DEPTH) return;

  for (const prop of decl.obj.getProperties()) {
    let key: string | null = null;
    let value: Node | undefined;

    if (Node.isPropertyAssignment(prop)) {
      const nameNode = prop.getNameNode();
      if (Node.isIdentifier(nameNode)) key = nameNode.getText();
      else if (Node.isStringLiteral(nameNode)) key = nameNode.getLiteralValue();
      value = prop.getInitializer();
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      key = prop.getName();
      value = prop.getNameNode();
    }

    if (key === null || !SAFE_KEY_RE.test(key) || !value) continue;
    const procedurePath = prefix ? `${prefix}.${key}` : key;

    // (a) Inline nested router: `user: router({ … })`.
    const inline = routerObjectArg(value);
    if (inline) {
      walkRouter({ name: '', obj: inline, sf: decl.sf, line: 0 }, procedurePath, ctx, visited, depth + 1);
      continue;
    }

    // (b) Sub-router referenced by name, possibly declared in another file.
    if (Node.isIdentifier(value)) {
      const named = ctx.graph.byName.get(value.getText());
      if (named && !visited.has(named.name)) {
        walkRouter(named, procedurePath, ctx, new Set(visited).add(named.name), depth + 1);
      }
      continue;
    }

    // (c) Procedure.
    const chain = parseProcedureChain(value);
    if (!chain) continue;
    // Subscriptions are out of scope: they are a long-lived SSE/WebSocket stream, not
    // a request/response call the MCP call surface can model. See SPEC_TRPC_STACK.md.
    if (chain.procedureType === 'subscription') continue;
    if (ctx.seen.has(procedurePath)) continue;
    ctx.seen.add(procedurePath);

    const procedureType = chain.procedureType;
    let inputSchema: JsonSchema2020;
    let inputSchemaConfidence: InputSchemaConfidence;
    if (!chain.inputNode) {
      inputSchema = noInputSchema();
      inputSchemaConfidence = 'introspected';
    } else {
      const resolved = resolveZodArg(chain.inputNode, decl.sf);
      inputSchema = resolved ?? unknownSchema();
      inputSchemaConfidence = resolved ? 'introspected' : 'unknown';
    }
    const outputSchema = resolveZodArg(chain.outputNode, decl.sf) ?? undefined;

    const descriptor: TrpcToolDescriptor = { procedureType, procedurePath };
    ctx.tools.push({
      name: procedureToolName(procedureType, procedurePath),
      toolId: computeTrpcToolId(procedureType, procedurePath),
      // The tRPC HTTP adapter serves queries over GET and mutations over POST.
      method: procedureType === 'query' ? 'GET' : 'POST',
      path: ctx.trpcPath,
      inputSchema,
      inputSchemaConfidence,
      ...(outputSchema ? { outputSchema } : {}),
      sideEffectClass: procedureType === 'query' ? 'safe' : 'mutating',
      sourceFile: relPosix(ctx.root, decl.sf.getFilePath()),
      sourceLine: prop.getStartLineNumber(),
      sourceFunctionName: procedurePath,
      isServerAction: false,
      trpc: descriptor,
    });
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Extract one MCP tool per tRPC procedure, keyed by its full dotted path under the
 * mounted root router. `trpcPath` (default '/api/trpc') becomes each tool's `path`;
 * the dotted procedure path lives in the `trpc` descriptor and is appended to that
 * mount point at call time.
 */
export function extractTrpcRouter(root: string, trpcPath = '/api/trpc'): RawToolMeta[] {
  const files = walkTs(root).sort((a, b) => relPosix(root, a).localeCompare(relPosix(root, b)));
  if (files.length === 0) return [];

  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
  });
  for (const file of files) {
    try {
      project.addSourceFileAtPath(file);
    } catch {
      // unreadable / unparsable — skip
    }
  }

  const graph = collectRouters(project.getSourceFiles());

  // Walk candidate roots best-first, stopping at the first that yields procedures, so a
  // same-shaped non-tRPC `router({…})` call can't shadow the real root.
  for (const candidate of rootRouterCandidates(graph)) {
    const ctx: WalkContext = { root, trpcPath, graph, tools: [], seen: new Set() };
    const visited = new Set<string>(candidate.name ? [candidate.name] : []);
    walkRouter(candidate, '', ctx, visited, 0);
    if (ctx.tools.length > 0) return ctx.tools;
  }
  return [];
}

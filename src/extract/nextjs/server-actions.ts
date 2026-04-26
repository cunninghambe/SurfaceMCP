import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Project, SyntaxKind, Node } from 'ts-morph';
import type { ToolMeta } from '../../types.js';

// TODO(spec): Server action discovery is form-action only (v0.1).
// Closure-bound RPC actions deferred to v0.2.

function toolId(actionName: string, pagePath: string): string {
  return createHash('sha1').update(`serveraction:${actionName}:${pagePath}`).digest('hex').slice(0, 12);
}

function sanitizePath(p: string): string {
  return p.replace(/\//g, '_').replace(/[^a-z0-9_]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function walkDir(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, files);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
      files.push(full);
    }
  }
  return files;
}

type FormFieldInfo = {
  name: string;
  type: string;
};

function extractFormFields(content: string): FormFieldInfo[] {
  const fields: FormFieldInfo[] = [];
  // Match <input name="fieldName" type="text" />
  const inputPattern = /<input[^>]+name=["'](\w+)["'][^>]*(?:type=["'](\w+)["'])?[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = inputPattern.exec(content)) !== null) {
    fields.push({ name: match[1], type: match[2] ?? 'text' });
  }
  return fields;
}

function formFieldsToSchema(fields: FormFieldInfo[]): ToolMeta['inputSchema'] {
  if (fields.length === 0) {
    return { type: 'object', additionalProperties: true };
  }

  const properties: Record<string, { type: string; format?: string }> = {};
  const required: string[] = [];

  for (const field of fields) {
    const prop: { type: string; format?: string } = { type: 'string' };
    if (field.type === 'number') prop.type = 'number';
    else if (field.type === 'email') { prop.type = 'string'; prop.format = 'email'; }
    else if (field.type === 'checkbox') prop.type = 'boolean';
    properties[field.name] = prop;
    required.push(field.name);
  }

  return { type: 'object', properties, required };
}

export async function extractServerActions(root: string): Promise<ToolMeta[]> {
  const tools: ToolMeta[] = [];
  const appDir = resolve(root, 'app');

  if (!existsSync(appDir)) return tools;

  const files = walkDir(appDir);
  const pageFiles = files.filter((f) =>
    /page\.(ts|tsx|js|jsx)$/.test(f) || /layout\.(ts|tsx|js|jsx)$/.test(f)
  );

  for (const pageFile of pageFiles) {
    let content: string;
    try {
      content = readFileSync(pageFile, 'utf-8');
    } catch {
      continue;
    }

    // Only process files that use server actions in <form action={fn}> pattern
    if (!/<form\s[^>]*action=\{/.test(content)) continue;

    try {
      const project = new Project({ useInMemoryFileSystem: false });
      const sf = project.addSourceFileAtPath(pageFile);

      // Find JSX form elements with action={fn}
      const jsxAttrs = sf.getDescendantsOfKind(SyntaxKind.JsxAttribute);
      for (const attr of jsxAttrs) {
        if (attr.getNameNode().getText() !== 'action') continue;
        const init = attr.getInitializer();
        if (!Node.isJsxExpression(init)) continue;

        const expr = init.getExpression();
        if (!expr) continue;
        const actionName = expr.getText().replace(/^props\./, '');

        // Find the parent form element to extract sibling inputs
        const formFields = extractFormFields(content);
        const schema = formFieldsToSchema(formFields);

        const pagePath = relative(root, pageFile);
        const sanitizedPage = sanitizePath(pagePath);

        tools.push({
          name: `serveraction_${actionName}__${sanitizedPage}`,
          toolId: toolId(actionName, pagePath),
          method: 'POST',
          path: `/${pagePath.replace(/\\/g, '/').replace(/\/page\.(ts|tsx|js|jsx)$/, '')}`,
          inputSchema: schema,
          inputSchemaConfidence: 'inferred',
          sideEffectClass: 'mutating',
          sourceFile: relative(root, pageFile),
          sourceLine: 1,
          isServerAction: true,
        });
      }
    } catch {
      // skip if AST parse fails
    }
  }

  return tools;
}

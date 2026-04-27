import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const EXTERNAL_INTEGRATIONS = [
  { pattern: /stripe/i, label: 'stripe' },
  { pattern: /sendgrid/i, label: 'sendgrid' },
  { pattern: /easypost/i, label: 'easypost' },
  { pattern: /cloudinary/i, label: 'cloudinary' },
  { pattern: /@aws-sdk/i, label: 'aws-sdk' },
  { pattern: /twilio/i, label: 'twilio' },
  { pattern: /mailgun/i, label: 'mailgun' },
  { pattern: /postmark/i, label: 'postmark' },
  { pattern: /pusher/i, label: 'pusher' },
  { pattern: /algolia/i, label: 'algolia' },
  { pattern: /plaid/i, label: 'plaid' },
];

type IntegrationHit = {
  lib: string;
  files: string[];
};

function walkDir(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (
      entry.isDirectory() &&
      !['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)
    ) {
      walkDir(full, files);
    } else if (/\.(ts|tsx|js|jsx|py)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Page/layout/system filenames that are UI-only and should not surface as integration files. */
const UI_FILENAME_PATTERN = /\/(page|layout|loading|error|not-found)\.(tsx|jsx)$/;

/**
 * True when the relative path looks like a Next.js page/layout file that should be skipped.
 * `pages/api/**` is excluded from the skip — those are real server routes.
 */
function isUiFile(file: string, root: string): boolean {
  const rel = file.startsWith(root) ? file.slice(root.length) : file;
  // app/**/page.tsx, layout.tsx, loading.tsx, error.tsx, not-found.tsx
  if (/^\/app\//.test(rel) && UI_FILENAME_PATTERN.test(rel)) return true;
  // pages/**/*.tsx excluding pages/api/**
  if (/^\/pages\//.test(rel) && !rel.startsWith('/pages/api/') && /\.(tsx|jsx)$/.test(rel)) return true;
  return false;
}

/** True when the file begins with a `'use client'` directive (checked in the first 200 bytes). */
function isClientComponent(content: string): boolean {
  const head = content.slice(0, 200);
  return /^['"]use client['"]/.test(head.trimStart());
}

/**
 * Extract import targets from source text using regex.
 * Matches: import … from '<lib>', import('<lib>'), require('<lib>').
 */
function extractImportTargets(content: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /import\s+(?:[\w{},\s*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      targets.push(m[1]);
    }
  }
  return targets;
}

export function detectExternalIntegrations(root: string): IntegrationHit[] {
  const allFiles = walkDir(root);
  const hits = new Map<string, string[]>();

  for (const file of allFiles) {
    if (isUiFile(file, root)) continue;

    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    if (isClientComponent(content)) continue;

    const importTargets = extractImportTargets(content);

    for (const { pattern, label } of EXTERNAL_INTEGRATIONS) {
      if (importTargets.some((target) => pattern.test(target))) {
        const existing = hits.get(label) ?? [];
        existing.push(file.replace(root + '/', ''));
        hits.set(label, existing);
      }
    }
  }

  return Array.from(hits.entries()).map(([lib, files]) => ({ lib, files }));
}

#!/usr/bin/env bash
# Manual smoke test: verify closure-nav resolution on TraiderJo's Navbar.tsx.
# Run from /root/SurfaceMCP: bash scripts/smoke-traiderjo-closure-nav.sh
set -euo pipefail

TRAIDERJO_ROOT="${1:-/tmp/TraiderJo}"

if [[ ! -d "$TRAIDERJO_ROOT" ]]; then
  echo "ERROR: TraiderJo root not found at $TRAIDERJO_ROOT"
  echo "Usage: $0 [/path/to/TraiderJo]"
  exit 1
fi

node --input-type=module <<EOF
import { extractViteNavigations } from '/root/SurfaceMCP/dist/extract/vite/navigations.js';

const root = '${TRAIDERJO_ROOT}';
const { navigations, skips } = await extractViteNavigations(root);

const navbarNavs = navigations.filter(n => n.sourceFile.includes('Navbar'));
const expectedTargets = ['dashboard', 'trades', 'plan', 'import', 'apr', 'profile', 'settings'];

const found = new Set(navbarNavs.map(n => n.target));
const missing = expectedTargets.filter(t => !found.has(t));

const navbarSkips = skips.filter(s => s.declaredAt?.file?.includes('Navbar') && s.reason === 'dynamic_target');

let ok = true;

if (missing.length > 0) {
  console.error('FAIL: missing targets from Navbar.tsx:', missing.join(', '));
  ok = false;
}

if (navbarSkips.length > 0) {
  console.error('FAIL: dynamic_target skips still present for Navbar.tsx:');
  navbarSkips.forEach(s => console.error('  ', JSON.stringify(s)));
  ok = false;
}

for (const t of expectedTargets) {
  const nav = navbarNavs.find(n => n.target === t);
  if (!nav) continue;
  if (nav.kind !== 'state') { console.error(\`FAIL: \${t} kind=\${nav.kind} (expected 'state')\`); ok = false; }
  if (nav.method !== 'state-setter') { console.error(\`FAIL: \${t} method=\${nav.method} (expected 'state-setter')\`); ok = false; }
  if (nav.stateVar !== 'setTab') { console.error(\`FAIL: \${t} stateVar=\${nav.stateVar} (expected 'setTab')\`); ok = false; }
  if (nav.confidence !== 'high') { console.error(\`FAIL: \${t} confidence=\${nav.confidence} (expected 'high')\`); ok = false; }
  if (!nav.triggerSelectorHint?.text) { console.error(\`FAIL: \${t} missing triggerSelectorHint.text\`); ok = false; }
}

if (ok) {
  console.log(\`OK: TraiderJo Navbar resolved (\${navbarNavs.length} navigations, \${navbarSkips.length} skips)\`);
  process.exit(0);
} else {
  console.error('Navbar navigations:', JSON.stringify(navbarNavs, null, 2));
  process.exit(1);
}
EOF

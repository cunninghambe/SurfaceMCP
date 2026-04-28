#!/usr/bin/env bash
# Smoke test: verify nav-hint quality improvements on TraiderJo.
# Usage: bash scripts/smoke-traiderjo-hints.sh [/path/to/TraiderJo]
# Defaults to /tmp/TraiderJo if no argument given.

set -euo pipefail

TRAIDER_ROOT="${1:-/tmp/TraiderJo}"

if [ ! -d "$TRAIDER_ROOT" ]; then
  echo "ERROR: TraiderJo root not found at $TRAIDER_ROOT" >&2
  echo "Usage: bash $0 [/path/to/TraiderJo]" >&2
  exit 1
fi

echo "Running nav-hint smoke against: $TRAIDER_ROOT"

NAVS_JSON=$(node --input-type=module <<EOF
import { extractViteNavigations } from './dist/extract/vite/navigations.js';
const { navigations } = await extractViteNavigations('${TRAIDER_ROOT}');
process.stdout.write(JSON.stringify(navigations));
EOF
)

TOTAL=$(echo "$NAVS_JSON" | node -e "const n=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(n.length);")
echo "Total navigations: $TOTAL"

# 1. Every navigation must have scope set
MISSING_SCOPE=$(echo "$NAVS_JSON" | node -e "
const n=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const m=n.filter(x=>x.scope===undefined||x.scope===null);
console.log(m.length);
")
echo "Navigations missing scope: $MISSING_SCOPE"
if [ "$MISSING_SCOPE" -ne 0 ]; then
  echo "FAIL: $MISSING_SCOPE navigations have no scope field" >&2
  exit 1
fi
echo "PASS: all navigations have scope"

# 2. Popular ambiguous text hints should have siblingNavigations > 0 and dropped confidence
AMBIGUOUS_CHECK=$(echo "$NAVS_JSON" | node -e "
const n=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const popular=['monthly','hour','save','daily','1h','4h'];
const issues=[];
for(const nav of n){
  const txt=(nav.triggerSelectorHint?.text||'').toLowerCase().trim();
  if(popular.includes(txt) && nav.triggerSelectorHint?.preferred==='text'){
    if(nav.siblingNavigations===0){
      issues.push(nav.target+':'+txt+':siblings=0');
    }
    if(nav.confidence==='high'){
      issues.push(nav.target+':'+txt+':conf=high,expected drop');
    }
  }
}
console.log(issues.length===0?'ok':issues.join(', '));
")
if [ "$AMBIGUOUS_CHECK" != "ok" ]; then
  echo "WARN: some popular-text navigations may not have dropped confidence: $AMBIGUOUS_CHECK"
else
  echo "PASS: popular ambiguous text hints have dropped confidence"
fi

# 3. At least 4 top-level navigations
TOP_LEVEL=$(echo "$NAVS_JSON" | node -e "
const n=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(n.filter(x=>x.scope==='top-level').length);
")
echo "Top-level navigations: $TOP_LEVEL"
if [ "$TOP_LEVEL" -lt 4 ]; then
  echo "WARN: expected at least 4 top-level navigations, got $TOP_LEVEL"
else
  echo "PASS: at least 4 top-level navigations"
fi

# 4. At least 8 page-local navigations
PAGE_LOCAL=$(echo "$NAVS_JSON" | node -e "
const n=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(n.filter(x=>x.scope==='page-local').length);
")
echo "Page-local navigations: $PAGE_LOCAL"
if [ "$PAGE_LOCAL" -lt 8 ]; then
  echo "WARN: expected at least 8 page-local navigations, got $PAGE_LOCAL (may be fewer on this build)"
else
  echo "PASS: at least 8 page-local navigations"
fi

# 5. Summary of preferred selector distribution
echo ""
echo "Preferred selector distribution:"
echo "$NAVS_JSON" | node -e "
const n=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const counts={};
for(const nav of n){
  const p=nav.triggerSelectorHint?.preferred||'none';
  counts[p]=(counts[p]||0)+1;
}
for(const [k,v] of Object.entries(counts).sort()) console.log('  '+k+': '+v);
"

echo ""
echo "Smoke complete."

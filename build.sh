#!/bin/sh
# Bundles the page. kgf-sparql is used as it is checked out next door, unmodified:
# its compiled engine, actors and RunAccount, resolved from its own node_modules.
set -e
cd "$(dirname "$0")"
KS="${KGF_SPARQL:-../kgf-sparql}"
if [ ! -f "$KS/packages/kgf-sparql/engine-default.js" ] || [ ! -f "$KS/packages/kgf-sparql/lib/QueryEngine.js" ]; then
  echo "kgf-sparql is not at $KS, or is not built. Clone it beside this checkout (or set KGF_SPARQL)" >&2
  echo "and run 'npm install && npm run build' there." >&2
  exit 1
fi
KS="$(cd "$KS" && pwd)"
KGF_SPARQL_VERSION=$(node -p "require('$KS/packages/kgf-sparql/package.json').version")
COMUNICA_VERSION=$(node -p "require('$KS/node_modules/@comunica/query-sparql/package.json').version")
# The commit a transcript was made with (D18); "-dirty" when the checkout had changes.
BUILD=$(git describe --always --dirty 2>/dev/null || echo unknown)
DEFINES="--define:KGF_SPARQL_VERSION=\"$KGF_SPARQL_VERSION\" --define:COMUNICA_VERSION=\"$COMUNICA_VERSION\" --define:KGF_EXPLORER_BUILD=\"$BUILD\""
# The FRINK gate's address, for the free model; empty, the page offers the development gate's.
NODE_PATH="$KS/node_modules" npx esbuild src/app.js --bundle --format=iife --platform=browser \
  --target=es2022 --minify --sourcemap --outfile=dist/app.js \
  --alias:kgf-sparql="$KS/packages/kgf-sparql" $DEFINES \
  --define:KGF_GATE_URL="\"${KGF_GATE_URL:-}\"" \
  --log-level=warning "$@"
# The gate's proof of work runs in a worker of its own (frink-llm-gate plan D8).
npx esbuild src/pow-worker.js --bundle --format=iife --platform=browser --target=es2022 --minify \
  --outfile=dist/pow-worker.js --log-level=warning
# The gate's manifest (frink-llm-gate plan D5), made from the source just bundled and signed when
# the build has the key, which never sits in this repository. Without it the free model is off.
rm -f dist/gate-manifest.txt
if [ -n "${KGF_GATE_KEY:-}" ]; then
  MANIFEST_TMP=$(mktemp -d)
  NODE_PATH="$KS/node_modules" npx esbuild gate-manifest.js --bundle --format=cjs --platform=node \
    --outfile="$MANIFEST_TMP/gate-manifest.cjs" --alias:kgf-sparql="$KS/packages/kgf-sparql" $DEFINES \
    --log-level=warning
  node --no-deprecation "$MANIFEST_TMP/gate-manifest.cjs" dist/gate-manifest.txt
  rm -rf "$MANIFEST_TMP"
else
  echo "KGF_GATE_KEY is not set: no gate manifest, so the free model is off in this build." >&2
fi
# DuckDB-Wasm runs in a worker from its own files, served beside the bundle (no CDN).
mkdir -p dist/duckdb
for f in duckdb-mvp.wasm duckdb-eh.wasm duckdb-browser-mvp.worker.js duckdb-browser-eh.worker.js; do
  cp -p "node_modules/@duckdb/duckdb-wasm/dist/$f" dist/duckdb/
done
# dist/ is the whole site. Its index.html names the bundle by hash, so a browser never runs a
# stale build; the source index.html is never rewritten.
HASH=$(shasum dist/app.js | cut -c1-10)
sed "s#<script src=\"app.js\"></script>#<script src=\"app.js?v=$HASH\"></script>#" index.html > dist/index.html

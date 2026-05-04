#!/usr/bin/env bash
# Deploy this project's asset-browser to Vercel + update stable alias.
# Usage (inside project's asset-browser/):  ./deploy.sh [alias]
# Alias defaults to "asset-browser-<projectName>.vercel.app"
set -e

SCOPE="${VERCEL_SCOPE:-skywalker2506s-projects}"

# Must run from an asset-browser install
[ -f config.json ] || { echo "Run from <project>/asset-browser/ directory"; exit 1; }

TITLE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("config.json","utf8")).title||"project")')"
SLUG="$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/--*/-/g; s/^-//; s/-$//')"
ALIAS="${1:-asset-browser-$SLUG.vercel.app}"

echo "Building…"
npm run build >/dev/null

echo "Deploying…"
URL=$(vercel --prod --yes --scope "$SCOPE" 2>&1 | grep -oE "https://[a-z0-9-]+\.vercel\.app" | tail -1)
[ -z "$URL" ] && { echo "Deploy failed"; exit 1; }

echo "Aliasing $URL -> $ALIAS"
vercel alias set "$URL" "$ALIAS" --scope "$SCOPE" >/dev/null

echo ""
echo "  Prod:  $URL"
echo "  Stable: https://$ALIAS"

#!/usr/bin/env bash
# Assemble the static web build of the Articulator into web-dist/.
# Used by the Render static service (see render.yaml) and runnable locally.
# The app is plain ES modules + static assets — no bundler needed.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf web-dist
mkdir -p web-dist/lib web-dist/fonts web-dist/sounds

cp index.html app.js vocal-tract.js ipa-data.js accent-data.js styles.css \
   SV_Logo.png icon.png privacy.html terms.html support.html web-dist/
cp -r lib/* web-dist/lib/
cp fonts/* web-dist/fonts/ 2>/dev/null || true
cp sounds/* web-dist/sounds/ 2>/dev/null || true

echo "web-dist assembled ($(find web-dist -type f | wc -l | tr -d ' ') files)"

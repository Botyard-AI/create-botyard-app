#!/usr/bin/env bash
# Builds and tests every app in examples/ the way a user's generated app is
# built: from its own package-lock.json, against our packages as published on
# npm (exact versions), not against the sources in this repository.
#
# - `npm ci` installs exactly the lockfile, with no install scripts
#   (--ignore-scripts, as well as the app's own .npmrc).
# - NODE_ENV=development, because npm skips devDependencies when it is
#   "production", and the checks need them.
# - Then each app's own lint, format:check, typecheck, test and build.
#
# Usage: scripts/check-examples.sh [examples/<name> ...]   (default: all)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
export NODE_ENV=development

if [ "$#" -gt 0 ]; then
  apps=("$@")
else
  apps=()
  for pkg in "$root"/examples/*/package.json; do
    [ -f "$pkg" ] && apps+=("$(dirname "$pkg")")
  done
fi
[ "${#apps[@]}" -gt 0 ] || { echo "no examples found" >&2; exit 1; }

for app in "${apps[@]}"; do
  dir="$(cd "$app" && pwd)"
  [ -f "$dir/package-lock.json" ] || { echo "$dir has no package-lock.json" >&2; exit 1; }
  echo "::group::${dir#"$root"/}"
  (
    cd "$dir"
    npm ci --ignore-scripts --no-audit --no-fund
    npm run lint
    npm run format:check
    npm run typecheck
    npm test
    npm run build
  )
  echo "::endgroup::"
done

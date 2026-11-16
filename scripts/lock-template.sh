#!/usr/bin/env bash
# Regenerates templates/<name>/package-lock.json, the lockfile generated apps
# install from, under this repository's supply-chain rules:
#
# - Every third-party version is resolved as of 3 days ago (npm --before),
#   matching pnpm-workspace.yaml's minimumReleaseAge.
# - Our own @botyard/* packages, published from this repository with
#   provenance, are added afterwards without the age limit. They have no
#   dependencies of their own, so nothing else is resolved late.
# - No install scripts run (--package-lock-only --ignore-scripts).
#
# Usage: scripts/lock-template.sh full-app
set -euo pipefail

name="${1:?usage: scripts/lock-template.sh <template>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
template="$root/templates/$name"
[ -f "$template/package.json" ] || { echo "no template $name" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
before="$(node -e 'console.log(new Date(Date.now() - 3 * 86400e3).toISOString())')"

# Step 1: the template without @botyard/*, resolved as of $before.
node -e '
  const fs = require("node:fs")
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const own = Object.keys(pkg.dependencies ?? {}).filter((n) => n.startsWith("@botyard/"))
  for (const n of own) delete pkg.dependencies[n]
  fs.writeFileSync(process.argv[2] + "/package.json", JSON.stringify(pkg, null, 2) + "\n")
  fs.writeFileSync(process.argv[2] + "/own.txt", own.map((n) => n + "@" + JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dependencies[n]).join("\n"))
' "$template/package.json" "$work"
(cd "$work" && NODE_ENV=development npm install --package-lock-only --ignore-scripts \
  --no-audit --no-fund --before="$before")

# Step 2: add @botyard/* at their pinned versions, keeping everything else.
if [ -s "$work/own.txt" ]; then
  # shellcheck disable=SC2046
  (cd "$work" && NODE_ENV=development npm install --package-lock-only --ignore-scripts \
    --no-audit --no-fund --save-exact $(cat "$work/own.txt"))
fi

cp "$work/package-lock.json" "$template/package-lock.json"
echo "Wrote templates/$name/package-lock.json (third-party versions as of $before)."

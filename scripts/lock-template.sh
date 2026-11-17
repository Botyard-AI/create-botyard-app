#!/usr/bin/env bash
# Regenerates templates/<name>/package-lock.json, the lockfile generated apps
# install from, under this repository's supply-chain rules:
#
# - Every third-party version is resolved as of 3 days ago (npm --before),
#   matching pnpm-workspace.yaml's minimumReleaseAge.
# - The template's own packages, "workspace:*" in this repository, are locked
#   at the version in packages/*/package.json, as the CLI build pins them.
#   Only the packages in OWN may be; anything else fails.
# - Those are added in a second step without the age limit, which is then
#   checked to have added exactly those packages and changed nothing else: no
#   new or different third-party entry, no dependencies, no install scripts.
# - No install scripts run (--package-lock-only --ignore-scripts).
#
# Usage: scripts/lock-template.sh full-app
set -euo pipefail

# Our packages, published from this repository by release.yml with provenance.
OWN="@botyard/runtime @botyard/botpage"

name="${1:?usage: scripts/lock-template.sh <template>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
template="$root/templates/$name"
[ -f "$template/package.json" ] || { echo "no template $name" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
before="$(node -e 'console.log(new Date(Date.now() - 3 * 86400e3).toISOString())')"

# Step 1: the template without its own packages, resolved as of $before.
# Writes their name@version list to own.txt.
OWN="$OWN" node - "$root" "$template/package.json" "$work" <<'EOF'
const fs = require("node:fs")
const path = require("node:path")
const [root, pkgFile, work] = process.argv.slice(2)
const allowed = new Set(process.env.OWN.split(" "))
const versions = new Map()
for (const dir of fs.readdirSync(path.join(root, "packages"))) {
  const file = path.join(root, "packages", dir, "package.json")
  if (!fs.existsSync(file)) continue
  const p = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!p.private) versions.set(p.name, p.version)
}
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
const own = []
for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
    if (!spec.startsWith("workspace:")) continue
    if (field !== "dependencies" || spec !== "workspace:*" || !allowed.has(dep) || !versions.has(dep)) {
      console.error(`${field}.${dep} is "${spec}": only dependencies in OWN may be "workspace:*".`)
      process.exit(1)
    }
    own.push(`${dep}@${versions.get(dep)}`)
    delete pkg[field][dep]
  }
}
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
fs.writeFileSync(path.join(work, "own.txt"), own.join("\n"))
EOF
(cd "$work" && NODE_ENV=development npm install --package-lock-only --ignore-scripts \
  --no-audit --no-fund --before="$before")
cp "$work/package-lock.json" "$work/step1.json"

# Step 2: add our own packages at their versions, keeping everything else.
if [ -s "$work/own.txt" ]; then
  # shellcheck disable=SC2046
  (cd "$work" && NODE_ENV=development npm install --package-lock-only --ignore-scripts \
    --no-audit --no-fund --save-exact $(cat "$work/own.txt"))
fi

# Check step 2 added exactly our packages, each a leaf, and nothing else.
node - "$work/step1.json" "$work/package-lock.json" "$work/own.txt" <<'EOF'
const fs = require("node:fs")
const { isDeepStrictEqual } = require("node:util")
const [step1File, finalFile, ownFile] = process.argv.slice(2)
const step1 = JSON.parse(fs.readFileSync(step1File, "utf8")).packages
const final = JSON.parse(fs.readFileSync(finalFile, "utf8")).packages
const own = new Map(
  fs.readFileSync(ownFile, "utf8").split("\n").filter(Boolean).map((spec) => {
    const at = spec.lastIndexOf("@")
    return [`node_modules/${spec.slice(0, at)}`, spec.slice(at + 1)]
  })
)
const problems = []
for (const key of new Set([...Object.keys(step1), ...Object.keys(final)])) {
  if (key === "") continue
  if (own.has(key)) {
    const entry = final[key] ?? {}
    if (key in step1) problems.push(`${key} was already resolved as a third-party package`)
    if (entry.version !== own.get(key)) problems.push(`${key} is ${entry.version}, expected ${own.get(key)}`)
    if (!entry.resolved?.startsWith("https://registry.npmjs.org/") || !entry.integrity?.startsWith("sha512-"))
      problems.push(`${key} is not locked to the npm registry by sha512 integrity`)
    if (Object.keys(entry.dependencies ?? {}).length > 0) problems.push(`${key} has dependencies`)
    const meta = entry.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(entry.peerDependencies ?? {}))
      if (!meta[peer]?.optional) problems.push(`${key} has a required peer dependency ${peer}`)
    if (entry.hasInstallScript) problems.push(`${key} has an install script`)
  } else if (!isDeepStrictEqual(step1[key], final[key])) {
    problems.push(`${key} changed when adding our own packages`)
  }
}
if (problems.length > 0) {
  console.error(`Refusing the lockfile:\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
EOF

cp "$work/package-lock.json" "$template/package-lock.json"
echo "Wrote templates/$name/package-lock.json (third-party versions as of $before)."

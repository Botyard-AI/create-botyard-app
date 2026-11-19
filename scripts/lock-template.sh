#!/usr/bin/env bash
# Regenerates templates/<name>/package-lock.json, the lockfile generated apps
# install from, or examples/<name>/package-lock.json, under this repository's
# supply-chain rules:
#
# - Every third-party version is resolved as of 3 days ago (npm --before),
#   matching pnpm-workspace.yaml's minimumReleaseAge.
# - The template's own packages, "workspace:*" in this repository, are locked
#   at the version in packages/*/package.json, as the CLI build pins them.
#   Only the packages in OWN may be; anything else fails.
# - An example is built on our packages as published: it pins each package in
#   OWN to an exact version (as a generated app does), and is locked at that
#   version. It may not use "workspace:" at all.
# - Those are added in a second step without the age limit, which is then
#   checked to have added exactly those packages and changed nothing else: no
#   new or different third-party entry, no dependencies, no install scripts.
# - No install scripts run (--package-lock-only --ignore-scripts).
#
# Usage: scripts/lock-template.sh full-app
#        scripts/lock-template.sh examples/quote-desk
set -euo pipefail

# Our packages, published from this repository by release.yml with provenance.
OWN="@botyard/runtime @botyard/botpage"

name="${1:?usage: scripts/lock-template.sh <template> | examples/<name>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
case "$name" in
  examples/*) kind=example; dir=examples; base="${name#examples/}" ;;
  *) kind=template; dir=templates; base="$name" ;;
esac
# One plain directory name: no "..", no further slashes, no symlink out of $dir.
if ! [[ "$base" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || [ -L "$root/$dir/$base" ]; then
  echo "usage: scripts/lock-template.sh <template> | examples/<name>" >&2
  exit 1
fi
name="$dir/$base"
template="$root/$name"
[ -f "$template/package.json" ] || { echo "no $kind $name" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
before="$(node -e 'console.log(new Date(Date.now() - 3 * 86400e3).toISOString())')"

# Step 1: the template without its own packages, resolved as of $before.
# Writes their name@version list to own.txt.
OWN="$OWN" node - "$root" "$template/package.json" "$work" "$kind" <<'EOF'
const fs = require("node:fs")
const path = require("node:path")
const [root, pkgFile, work, kind] = process.argv.slice(2)
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
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
    if (kind === "example") {
      if (spec.startsWith("workspace:")) {
        console.error(`${field}.${dep} is "${spec}": examples use our packages as published, never "workspace:".`)
        process.exit(1)
      }
      if (!allowed.has(dep)) continue
      if (field !== "dependencies" || !EXACT.test(spec)) {
        console.error(`${field}.${dep} is "${spec}": an example pins our packages to an exact version in dependencies.`)
        process.exit(1)
      }
      own.push(`${dep}@${spec}`)
      delete pkg[field][dep]
      continue
    }
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
# npm can apply an "overrides" entry only on a second pass over an existing
# lockfile (seen with minimatch's range override), so resolve until the
# lockfile stops changing. Three passes is plenty; more means it never settles.
settled=""
for pass in 1 2 3; do
  (cd "$work" && NODE_ENV=development npm install --package-lock-only --ignore-scripts \
    --no-audit --no-fund --before="$before")
  if [ -f "$work/step1.json" ] && cmp -s "$work/package-lock.json" "$work/step1.json"; then
    settled=yes
    break
  fi
  cp "$work/package-lock.json" "$work/step1.json"
done
[ -n "$settled" ] || { echo "the lockfile did not settle after $pass passes" >&2; exit 1; }

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
echo "Wrote $name/package-lock.json (third-party versions as of $before)."

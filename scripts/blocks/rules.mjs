// The rules every block in registry/registry.json must follow, checked by
// scripts/check-blocks.mjs before it adds any block to a generated app.
//
// A user adds a block with `npx shadcn add @botyard/<block>`, and shadcn
// installs the block's npm dependencies with `npm install <name>@<version>`.
// So that install resolves to what we tested:
//
// - npm dependencies are exact versions, `<name>@<x.y.z>`, never a range or a
//   bare name (which npm resolves to whatever is newest);
// - registryDependencies name only other @botyard blocks. A shadcn/ui
//   component such as "button" lists its npm dependencies without versions,
//   so a block that needs one ships its own copy with pinned dependencies.
//
// The minimum release age and the no-install-scripts rule are checked when
// the dependencies are locked (scripts/lock-template.sh --app).

export const NAMESPACE = "@botyard"

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const EXACT = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/**
 * Splits "<name>@<version>" (the name may be scoped) into its two parts.
 * @param {string} spec
 * @returns {[string, string]}
 */
export function splitSpec(spec) {
  const at = spec.lastIndexOf("@")
  return [spec.slice(0, at), spec.slice(at + 1)]
}

/**
 * Every rule broken by the registry's items, as readable messages.
 * @param {Map<string, Record<string, unknown>>} items built items by name
 * @returns {string[]}
 */
export function registryProblems(items) {
  const problems = []
  for (const [name, item] of items) {
    if (!NAME.test(name)) problems.push(`${name}: block names are lowercase words joined by "-"`)
    for (const field of ["dependencies", "devDependencies"]) {
      for (const spec of stringList(item[field])) {
        if (!EXACT.test(spec)) {
          problems.push(`${name}: ${field} "${spec}" must be an exact version, "<name>@<x.y.z>"`)
        }
      }
    }
    for (const dep of stringList(item["registryDependencies"])) {
      const other = dep.startsWith(`${NAMESPACE}/`) ? dep.slice(NAMESPACE.length + 1) : undefined
      if (other === undefined) {
        problems.push(`${name}: registryDependencies "${dep}" must be a ${NAMESPACE} block`)
      } else if (!items.has(other)) {
        problems.push(`${name}: registryDependencies "${dep}" is not in registry.json`)
      }
    }
  }
  return problems
}

/**
 * The npm dependencies a block brings, with those of the blocks it depends
 * on, as name to exact version. Assumes `registryProblems(items)` is empty.
 * @param {string} name
 * @param {Map<string, Record<string, unknown>>} items
 * @returns {{ dependencies: Map<string, string>, devDependencies: Map<string, string> }}
 */
export function npmDependencies(name, items) {
  const result = { dependencies: new Map(), devDependencies: new Map() }
  const seen = new Set()
  const queue = [name]
  while (queue.length > 0) {
    const next = queue.shift() ?? ""
    if (seen.has(next)) continue
    seen.add(next)
    const item = items.get(next) ?? {}
    for (const field of /** @type {const} */ (["dependencies", "devDependencies"])) {
      for (const spec of stringList(item[field])) {
        const [dep, version] = splitSpec(spec)
        const other = result[field].get(dep)
        if (other !== undefined && other !== version) {
          throw new Error(`${dep} is pinned to both ${other} and ${version} in ${name}'s blocks`)
        }
        result[field].set(dep, version)
      }
    }
    for (const dep of stringList(item["registryDependencies"])) {
      queue.push(dep.slice(NAMESPACE.length + 1))
    }
  }
  return result
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`expected a list of strings, got ${JSON.stringify(value)}`)
  }
  return value
}

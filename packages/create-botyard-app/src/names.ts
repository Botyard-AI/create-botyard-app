import { builtinModules } from "node:module"

// The rules npm applies to the name of a new package (validate-npm-package-name),
// without the dependency: lowercase, URL-safe, 1 to 214 characters, optionally
// scoped, not starting with "." or "_", and not a Node core module.
const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/
const RESERVED = new Set(["node_modules", "favicon.ico"])
const CORE = new Set(builtinModules)

export function packageNameProblem(name: string): string | null {
  if (name.length === 0) return "is empty"
  if (name.length > 214) return "is longer than 214 characters"
  if (name !== name.toLowerCase()) return "must be lowercase"
  if (name.startsWith(".") || name.startsWith("_")) return 'must not start with "." or "_"'
  if (!NAME.test(name)) return "may only contain a-z, 0-9, '-', '.', '_' and '~'"
  if (RESERVED.has(name)) return "is reserved"
  if (CORE.has(name)) return "is the name of a Node.js core module"
  return null
}

// A Bot Page label is at most 80 characters; use the unscoped part of the name.
export function pageName(packageName: string): string {
  const unscoped = packageName.slice(packageName.indexOf("/") + 1)
  return unscoped.slice(0, 80)
}

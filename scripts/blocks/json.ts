// Reading JSON files whose shape we do not control (registry items, an app's
// package.json, components.json and package-lock.json): parse to `unknown`,
// then check each field before it is used.

import { readFile, writeFile } from "node:fs/promises"

export type JsonObject = Readonly<Record<string, unknown>>

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"))
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** `value` as an object, or an error naming `what`. */
export function object(value: unknown, what: string): JsonObject {
  if (!isObject(value)) throw new Error(`${what} is not an object`)
  return value
}

/** `value` as a list of strings; a missing field is an empty list. */
export function stringList(value: unknown, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`)
  return value.map((entry: unknown, i) => {
    if (typeof entry !== "string") throw new Error(`${what}[${i}] is not a string`)
    return entry
  })
}

/** `value` as an object of strings, like package.json's `dependencies`. */
export function stringRecord(value: unknown, what: string): Record<string, string> {
  if (value === undefined) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(object(value, what))) {
    if (typeof entry !== "string") throw new Error(`${what}.${key} is not a string`)
    result[key] = entry
  }
  return result
}

/** One entry of package-lock.json's `packages`, with the fields we check. */
export type LockEntry = {
  readonly version: string | undefined
  readonly resolved: string | undefined
  readonly integrity: string | undefined
  readonly hasInstallScript: boolean
}

/** package-lock.json's `packages`, by key such as "node_modules/zod". */
export function lockEntries(value: unknown, what: string): Map<string, LockEntry> {
  const packages = object(object(value, what)["packages"], `${what} packages`)
  const entries = new Map<string, LockEntry>()
  for (const [key, raw] of Object.entries(packages)) {
    const entry = object(raw, `${what} ${key}`)
    entries.set(key, {
      version: optionalString(entry["version"], `${what} ${key}.version`),
      resolved: optionalString(entry["resolved"], `${what} ${key}.resolved`),
      integrity: optionalString(entry["integrity"], `${what} ${key}.integrity`),
      hasInstallScript: optionalBoolean(
        entry["hasInstallScript"],
        `${what} ${key}.hasInstallScript`
      ),
    })
  }
  return entries
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined || typeof value === "string") return value
  throw new Error(`${what} is not a string`)
}

function optionalBoolean(value: unknown, what: string): boolean {
  if (value === undefined) return false
  if (typeof value === "boolean") return value
  throw new Error(`${what} is not a boolean`)
}

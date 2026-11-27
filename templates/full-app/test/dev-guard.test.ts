import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { isPrivate, keepPrivate } from "../server/dev-guard.ts"

let dir: string
let root: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "full-app-guard-"))
  root = path.join(dir, "app")
  await mkdir(path.join(root, "data"), { recursive: true })
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "data", "store.json"), "{}")
  await writeFile(path.join(root, "src", "main.ts"), "")
  await writeFile(path.join(dir, "trace.jsonl"), "")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("isPrivate", () => {
  test("data/ and the trace files are private, by any name; the rest is not", async () => {
    const files = [path.join(dir, "trace.jsonl"), path.join(dir, "trace.1.jsonl")]
    await symlink(path.join(root, "data", "store.json"), path.join(root, "src", "a.txt"))
    await symlink(path.join(dir, "trace.jsonl"), path.join(root, "src", "b.txt"))
    await symlink(path.join(root, "data"), path.join(root, "d"))
    const at = { root, files }
    expect(isPrivate(at, path.join(root, "data", "store.json"))).toBe(true)
    expect(isPrivate(at, path.join(root, "src", "a.txt"))).toBe(true)
    expect(isPrivate(at, path.join(root, "src", "b.txt"))).toBe(true)
    expect(isPrivate(at, path.join(root, "d", "store.json"))).toBe(true)
    expect(isPrivate(at, path.join(dir, "trace.jsonl"))).toBe(true)
    expect(isPrivate(at, path.join(root, "src", "main.ts"))).toBe(false)
    expect(isPrivate(at, path.join(root, "src", "missing.ts"))).toBe(false)
  })

  test("a rotated file created after startup is private too", async () => {
    const rotated = path.join(dir, "trace.1.jsonl")
    const at = { root, files: [rotated] }
    await symlink(rotated, path.join(root, "src", "c.txt"))
    await writeFile(rotated, "")
    expect(isPrivate(at, path.join(root, "src", "c.txt"))).toBe(true)
  })
})

test("load refuses a private module, whatever its query", async () => {
  await symlink(path.join(dir, "trace.jsonl"), path.join(root, "src", "b.txt"))
  const plugin = keepPrivate({ root, files: [path.join(dir, "trace.jsonl")] })
  const load = plugin.load
  if (typeof load !== "function") throw new Error("keepPrivate has no load hook")
  const call = (id: string): unknown => Reflect.apply(load, {}, [id])
  expect(() => call(`${path.join(root, "src", "b.txt")}?raw`)).toThrow("private")
  expect(() => call(path.join(root, "data", "store.json"))).toThrow("private")
  expect(call(path.join(root, "src", "main.ts"))).toBeNull()
})

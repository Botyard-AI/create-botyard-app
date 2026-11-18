import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { readJson, syncPath, writeJson } from "../server/quotes/store.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "quote-desk-"))
  dirs.push(dir)
  return dir
}

const read = (file: string) => readJson(file, (v) => v)

test("writeJson replaces the file and leaves no temporary file", () => {
  const file = path.join(tempDir(), "state.json")
  writeJson(file, { n: 1 })
  writeJson(file, { n: 2 })
  expect(read(file)).toEqual({ n: 2 })
  expect(readdirSync(path.dirname(file))).toEqual(["state.json"])
})

test("the file is synced before the rename, then its directory and each one created", () => {
  const root = tempDir()
  const file = path.join(root, "data", "reviews", "handoffs.json")
  const synced: string[] = []
  writeJson(file, { n: 1 }, (p) => {
    synced.push(p.endsWith(".tmp") ? "tmp" : path.relative(root, p) || ".")
    syncPath(p)
  })
  // reviews holds the rename; data holds reviews; root holds data.
  expect(synced).toEqual(["tmp", "data/reviews", "data", "."])
})

test("a directory sync that fails after the rename is reported, not thrown", () => {
  const file = path.join(tempDir(), "state.json")
  writeJson(file, { n: 1 })
  const failDirs = (p: string) => {
    if (!p.endsWith(".tmp")) throw new Error("EIO")
    syncPath(p)
  }
  // Returns normally, reporting it as not durable: the caller's state and the
  // disk agree on the new value, but a power cut could still undo it.
  expect(writeJson(file, { n: 2 }, failDirs)).toBe(false)
  expect(read(file)).toEqual({ n: 2 })
  expect(writeJson(file, { n: 3 })).toBe(true)
})

test("a file sync that fails before the rename is a failed save, and nothing changes", () => {
  const file = path.join(tempDir(), "state.json")
  writeJson(file, { n: 1 })
  expect(() => {
    writeJson(file, { n: 2 }, () => {
      throw new Error("EIO")
    })
  }).toThrow("EIO")
  expect(read(file)).toEqual({ n: 1 })
  expect(readdirSync(path.dirname(file))).toEqual(["state.json"])
})

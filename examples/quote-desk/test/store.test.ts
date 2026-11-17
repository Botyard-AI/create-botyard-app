import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { readJson, writeJson } from "../server/quotes/store.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test("writeJson replaces the file, synced, and leaves no temporary file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "quote-desk-"))
  dirs.push(dir)
  const file = path.join(dir, "data", "state.json")
  writeJson(file, { n: 1 })
  writeJson(file, { n: 2 })
  expect(readJson(file, (v) => v)).toEqual({ n: 2 })
  expect(readdirSync(path.dirname(file))).toEqual(["state.json"])
})

// The real templates/full-app, bundled the way the build bundles it, then
// scaffolded the way a user scaffolds it.
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import { bundleTemplates } from "../scripts/bundle.ts"
import type { Registry } from "../scripts/pin.ts"
import {
  isAhead,
  pinOptionsFromEnv,
  pinWorkspaceDependencies,
  readWorkspaceVersions,
} from "../scripts/pin.ts"
import { listFiles, readJson, run, tempDir } from "./helpers.ts"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const source = path.join(repoRoot, "templates", "full-app")

/**
 * The registry as the template's lockfile describes it, so the test runs
 * offline. The build checks the real registry (scripts/bundle-templates.ts).
 */
async function lockfileRegistry(): Promise<Registry> {
  const lock = await readJson(path.join(source, "package-lock.json"))
  const packages = isRecord(lock) && isRecord(lock["packages"]) ? lock["packages"] : {}
  return async (name) => {
    const entry = packages[`node_modules/${name}`]
    const version = isRecord(entry) ? entry["version"] : undefined
    const integrity = isRecord(entry) ? entry["integrity"] : undefined
    return {
      latest: typeof version === "string" ? version : undefined,
      integrity: (v) => (v === version && typeof integrity === "string" ? integrity : undefined),
    }
  }
}

let bundleDir: string
let out: string
let pinned: Map<string, string>
// Shared by the tests below, so not a tempDir(), which goes after each test.
beforeAll(async () => {
  bundleDir = await mkdtemp(path.join(tmpdir(), "cba-bundle-"))
  out = path.join(bundleDir, "templates")
  const names = await bundleTemplates({
    sourceDir: path.join(repoRoot, "templates"),
    outDir: out,
    root: repoRoot,
  })
  expect(names).toContain("full-app")
  pinned = await pinWorkspaceDependencies(
    path.join(out, "full-app"),
    await readWorkspaceVersions(repoRoot),
    await lockfileRegistry(),
    // As the build does: in CI, a release bump is pinned before it is published.
    pinOptionsFromEnv()
  )
})
afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true })
})

test("full-app bundles to plain files and scaffolds a named app", async () => {
  const cwd = await tempDir()
  const result = await run(["quotes"], { cwd, templatesDir: out })
  expect(result).toMatchObject({ code: 0, stderr: "" })

  const app = path.join(cwd, "quotes")
  const files = await listFiles(app)
  for (const required of [
    ".gitignore",
    ".npmrc",
    "README.md",
    "botyard.json",
    "eslint.config.js",
    "eslint/base.js",
    "eslint/node.js",
    "eslint/react.js",
    "eslint/zero-any.js",
    "index.html",
    "package-lock.json",
    "package.json",
    "scripts/expose.ts",
    "server/app.ts",
    "server/index.ts",
    "src/App.tsx",
    "src/main.tsx",
    "test/app.test.ts",
    "vite.config.ts",
  ]) {
    expect(files).toContain(required)
  }
  expect(files.filter((f) => /(^|\/)(node_modules|dist)\//.test(f))).toEqual([])
  // The ESLint configs are real copies, not links into this repository.
  expect((await lstat(path.join(app, "eslint", "react.js"))).isSymbolicLink()).toBe(false)
  expect(await readFile(path.join(app, "eslint", "react.js"), "utf8")).toBe(
    await readFile(path.join(repoRoot, "tooling", "eslint-config", "react.js"), "utf8")
  )

  expect(await readJson(path.join(app, "package.json"))).toMatchObject({
    name: "quotes",
    private: true,
    dependencies: Object.fromEntries(pinned),
  })
  expect(await readJson(path.join(app, "botyard.json"))).toEqual({ name: "quotes", port: 8787 })
  expect(await readJson(path.join(app, "package-lock.json"))).toMatchObject({
    name: "quotes",
    packages: { "": { name: "quotes" } },
  })
  expect(await readFile(path.join(app, ".npmrc"), "utf8")).toMatch(/^ignore-scripts=true$/m)
})

test("the bundle pins the SDK packages this repository builds", () => {
  expect([...pinned.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
    "@botyard/botpage",
    "@botyard/runtime",
  ])
})

test("full-app's lockfile matches the bundled package.json and pins every package by integrity", async () => {
  const pkg = await readJson(path.join(out, "full-app", "package.json"))
  const lock = await readJson(path.join(source, "package-lock.json"))
  expect(lock).toMatchObject({ lockfileVersion: 3 })
  const packages = isRecord(lock) && isRecord(lock["packages"]) ? lock["packages"] : {}
  const root = packages[""]
  expect(isRecord(root) && isRecord(pkg)).toBe(true)
  if (!isRecord(root) || !isRecord(pkg)) return
  // Regenerate with scripts/lock-template.sh after changing dependencies.
  // During a release bump in CI the bundle pins our package ahead of npm's
  // latest, which the lockfile cannot lock yet: there, and only there, expect
  // the lockfile's published version instead.
  const expected = isRecord(pkg["dependencies"]) ? { ...pkg["dependencies"] } : {}
  const locked = isRecord(root["dependencies"]) ? root["dependencies"] : {}
  for (const [name, version] of pinned) {
    const lockedVersion = locked[name]
    if (
      pinOptionsFromEnv().allowUnpublishedBump === true &&
      typeof lockedVersion === "string" &&
      isAhead(version, lockedVersion)
    ) {
      expected[name] = lockedVersion
    }
  }
  expect(root["dependencies"]).toEqual(expected)
  expect(root["devDependencies"]).toEqual(pkg["devDependencies"])

  const unpinned = Object.entries(packages).filter(([key, entry]) => {
    if (key === "" || !isRecord(entry) || entry["inBundle"] === true) return false
    const resolved = entry["resolved"]
    const integrity = entry["integrity"]
    return !(
      typeof resolved === "string" &&
      resolved.startsWith("https://registry.npmjs.org/") &&
      typeof integrity === "string" &&
      integrity.startsWith("sha512-")
    )
  })
  expect(unpinned.map(([key]) => key)).toEqual([])
})

test("full-app pins every dependency to an exact version and has no install scripts", async () => {
  const pkg = await readJson(path.join(out, "full-app", "package.json"))
  expect(pkg).toMatchObject({ private: true })
  const field = (key: string): Record<string, unknown> => {
    const value = isRecord(pkg) ? pkg[key] : undefined
    return isRecord(value) ? value : {}
  }
  const deps = { ...field("dependencies"), ...field("devDependencies") }
  expect(Object.keys(deps).length).toBeGreaterThan(0)
  for (const [name, version] of Object.entries(deps)) {
    expect(version, name).toMatch(/^\d+\.\d+\.\d+$/)
  }
  const scripts = Object.keys(field("scripts"))
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) {
    expect(scripts).not.toContain(hook)
  }
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

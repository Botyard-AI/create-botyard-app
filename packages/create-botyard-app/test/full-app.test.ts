// The real templates/full-app, bundled the way the build bundles it, then
// scaffolded the way a user scaffolds it.
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { bundleTemplates } from "../scripts/bundle.ts"
import { listFiles, readJson, run, tempDir } from "./helpers.ts"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

test("full-app bundles to plain files and scaffolds a named app", async () => {
  const out = path.join(await tempDir(), "templates")
  const names = await bundleTemplates({
    sourceDir: path.join(repoRoot, "templates"),
    outDir: out,
    root: repoRoot,
  })
  expect(names).toContain("full-app")

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
  })
  expect(await readJson(path.join(app, "botyard.json"))).toEqual({ name: "quotes", port: 8787 })
  expect(await readJson(path.join(app, "package-lock.json"))).toMatchObject({
    name: "quotes",
    packages: { "": { name: "quotes" } },
  })
  expect(await readFile(path.join(app, ".npmrc"), "utf8")).toMatch(/^ignore-scripts=true$/m)
})

test("full-app's lockfile matches package.json and pins every package by integrity", async () => {
  const dir = path.join(repoRoot, "templates", "full-app")
  const pkg = await readJson(path.join(dir, "package.json"))
  const lock = await readJson(path.join(dir, "package-lock.json"))
  expect(lock).toMatchObject({ lockfileVersion: 3 })
  const packages = isRecord(lock) && isRecord(lock["packages"]) ? lock["packages"] : {}
  const root = packages[""]
  expect(isRecord(root) && isRecord(pkg)).toBe(true)
  if (!isRecord(root) || !isRecord(pkg)) return
  // Regenerate with scripts/lock-template.sh after changing dependencies.
  expect(root["dependencies"]).toEqual(pkg["dependencies"])
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
  const pkg = await readJson(path.join(repoRoot, "templates", "full-app", "package.json"))
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

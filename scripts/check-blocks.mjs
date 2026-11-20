#!/usr/bin/env node
// Adds every block in registry/registry.json to a freshly generated app, the
// way a user does, and runs the app's checks. A block that breaks a generated
// app fails CI. See docs/blocks.md.
//
// For each block:
// 1. Generate an app with the CLI built from this commit
//    (packages/create-botyard-app/dist; run `pnpm run build` first).
// 2. Point the app's @botyard registry at this commit's blocks, built and
//    served on 127.0.0.1, instead of https://blocks.botyard.io.
// 3. Add the block's npm dependencies to package.json and lock them with
//    scripts/lock-template.sh --app: every third-party version is at least
//    3 days old, and no newly locked package has an install script.
// 4. `npm ci`, then `shadcn add @botyard/<block>`. shadcn would install the
//    npm dependencies again with plain `npm install`, outside those rules, so
//    the server leaves them out of the block, and npm is replaced by a stub
//    that fails if shadcn runs it anyway.
// 5. The app's lint, format:check, typecheck, test and build.
//
// Usage: node scripts/check-blocks.mjs [block ...]   (default: every block)

import { spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { NAMESPACE, npmDependencies, registryProblems } from "./blocks/rules.mjs"

/** @typedef {{ packages: Record<string, { version?: string, hasInstallScript?: boolean }> }} Lockfile */

const root = path.resolve(import.meta.dirname, "..")
const shadcn = path.join(root, "node_modules", ".bin", "shadcn")
const cli = path.join(root, "packages", "create-botyard-app", "dist", "bin.js")

const work = await mkdtemp(path.join(os.tmpdir(), "check-blocks-"))
try {
  await main(process.argv.slice(2))
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await rm(work, { recursive: true, force: true })
}

/** @param {string[]} only */
async function main(only) {
  const items = await buildRegistry()
  const problems = registryProblems(items)
  if (problems.length > 0) throw new Error(`registry/registry.json:\n  ${problems.join("\n  ")}`)

  const blocks = only.length > 0 ? only : [...items.keys()]
  for (const name of blocks) {
    if (!items.has(name)) throw new Error(`no block "${name}" in registry/registry.json`)
  }

  const server = await serve(items)
  try {
    for (const name of blocks) {
      console.log(`::group::block ${name}`)
      await checkBlock(name, items, server.url)
      console.log("::endgroup::")
    }
  } finally {
    server.close()
  }
}

/** Builds the registry into the work directory and reads every item. */
async function buildRegistry() {
  const out = path.join(work, "r")
  await run(shadcn, ["build", "registry/registry.json", "--output", out], { cwd: root })
  const source = await readJson(path.join(root, "registry", "registry.json"))
  /** @type {Map<string, Record<string, unknown>>} */
  const items = new Map()
  for (const { name } of source.items) {
    items.set(name, await readJson(path.join(out, `${name}.json`)))
  }
  return items
}

/**
 * Serves each item at /r/<name>.json without its npm dependencies (see 4.).
 * @param {Map<string, Record<string, unknown>>} items
 */
async function serve(items) {
  const server = createServer((req, res) => {
    const name = /^\/r\/([a-z0-9-]+)\.json$/.exec(req.url ?? "")?.[1]
    const item = name === undefined ? undefined : items.get(name)
    if (item === undefined) {
      res.writeHead(404).end()
      return
    }
    // eslint-disable-next-line no-unused-vars -- dropped from the served item
    const { dependencies, devDependencies, ...rest } = item
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rest))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("server has no port")
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() }
}

/**
 * @param {string} name
 * @param {Map<string, Record<string, unknown>>} items
 * @param {string} registryUrl
 */
async function checkBlock(name, items, registryUrl) {
  const app = path.join(work, "apps", name)
  const env = { ...process.env, NODE_ENV: "development" }
  await run(process.execPath, [cli, app, "--name", "blocks-check"], { cwd: root })

  const pkgFile = path.join(app, "package.json")
  const lockFile = path.join(app, "package-lock.json")
  const pkg = await readJson(pkgFile)
  const generatedLock = await readJson(lockFile)
  if (unpublishedBump(pkg, generatedLock)) return

  const componentsFile = path.join(app, "components.json")
  const components = await readJson(componentsFile)
  components.registries = { [NAMESPACE]: `${registryUrl}/r/{name}.json` }
  await writeJson(componentsFile, components)

  const deps = npmDependencies(name, items)
  if (deps.dependencies.size + deps.devDependencies.size > 0) {
    for (const field of /** @type {const} */ (["dependencies", "devDependencies"])) {
      for (const [dep, version] of deps[field]) {
        const existing = pkg.dependencies[dep] ?? pkg.devDependencies[dep]
        if (existing !== undefined && existing !== version) {
          throw new Error(`${name} needs ${dep}@${version}; the template has ${existing}`)
        }
        pkg[field][dep] = version
      }
    }
    await writeJson(pkgFile, pkg)
    await run(path.join(root, "scripts", "lock-template.sh"), ["--app", app], { cwd: root })
    assertNoNewInstallScripts(generatedLock, await readJson(lockFile))
  }

  await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app, env })

  const stubs = await packageManagerStubs()
  const pkgBefore = await readFile(pkgFile, "utf8")
  await run(shadcn, ["add", `${NAMESPACE}/${name}`, "--yes"], {
    cwd: app,
    env: { ...env, PATH: `${stubs}${path.delimiter}${env.PATH ?? ""}` },
  })
  if ((await readFile(pkgFile, "utf8")) !== pkgBefore) {
    throw new Error(`shadcn add @botyard/${name} changed package.json`)
  }

  for (const script of ["lint", "format:check", "typecheck", "test", "build"]) {
    await run("npm", ["run", script], { cwd: app, env })
  }
}

/**
 * True, after a warning, when the app pins one of our packages at a version
 * that is not published yet: a release bump in CI (see pin.ts). It cannot be
 * installed until release.yml publishes it, so the blocks are checked again
 * then. Anywhere else it is an error.
 * @param {{ dependencies: Record<string, string> }} pkg
 * @param {Lockfile} lock
 */
function unpublishedBump(pkg, lock) {
  for (const [dep, version] of Object.entries(pkg.dependencies)) {
    if (!dep.startsWith(`${NAMESPACE}/`)) continue
    if (lock.packages[`node_modules/${dep}`]?.version === version) continue
    const message = `${dep}@${version} is not published yet, so a generated app cannot install it`
    if (process.env["BOTYARD_ALLOW_UNPUBLISHED_BUMP"] !== "1") throw new Error(message)
    console.log(`::warning::Skipping the blocks check: ${message}. It runs again once it is.`)
    return true
  }
  return false
}

/**
 * The template's lockfile may have entries with install scripts (fsevents);
 * the app's .npmrc never runs them. A block may not add any more.
 * @param {Lockfile} before
 * @param {Lockfile} after
 */
function assertNoNewInstallScripts(before, after) {
  for (const [key, entry] of Object.entries(after.packages)) {
    if (entry.hasInstallScript && !before.packages[key]?.hasInstallScript) {
      throw new Error(`${key.replace(/^node_modules\//, "")} has an install script`)
    }
  }
}

/** A directory of npm, pnpm, yarn and bun stubs that fail when run. */
async function packageManagerStubs() {
  const dir = path.join(work, "stubs")
  await mkdir(dir, { recursive: true })
  for (const tool of ["npm", "pnpm", "yarn", "bun"]) {
    const file = path.join(dir, tool)
    await writeFile(
      file,
      `#!/bin/sh\necho "shadcn ran ${tool} $*; blocks must not install" >&2\nexit 1\n`
    )
    await chmod(file, 0o755)
  }
  return dir
}

/**
 * Runs a command with inherited output; rejects unless it exits 0.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} options
 */
function run(command, args, { cwd, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined)
      else reject(new Error(`${path.basename(command)} ${args.join(" ")} exited with ${code}`))
    })
  })
}

/** @param {string} file */
async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

/**
 * @param {string} file
 * @param {unknown} value
 */
async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

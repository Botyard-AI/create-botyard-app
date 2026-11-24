// Adds every block in registry/registry.json to a freshly generated app, the
// way a user does, and runs the app's checks. A block that breaks a generated
// app fails CI, and registry.yml will not publish it. See docs/blocks.md.
//
// For each block:
// 1. Generate an app with the CLI built from this commit
//    (packages/create-botyard-app/dist).
// 2. Check that the app's components.json names the published @botyard
//    registry, https://blocks.botyard.io/r/{name}.json, then point it at the
//    built blocks in registry/dist (the files registry.yml publishes), served
//    on 127.0.0.1: the same URL with only the host changed.
// 3. Add the block's npm dependencies to package.json and lock them with
//    scripts/lock-template.sh --app: every third-party version is at least
//    3 days old, and no package has an install script unless the template
//    locks that exact package already.
// 4. `npm ci`, then `shadcn add @botyard/<block>`. shadcn would install the
//    npm dependencies again with plain `npm install`, outside those rules, so
//    the server leaves them out of the block, and npm is replaced by a stub
//    that fails if shadcn runs it anyway.
// 5. `shadcn search @botyard` lists the block, as a bot looking for blocks
//    would see it, from the built registry index.
// 6. The app's lint, format:check, typecheck, test and build.
//
// Run `pnpm run build` first: it builds both the CLI and registry/dist.
// Usage: node scripts/check-blocks.ts [block ...]   (default: every block)

import { execFile, spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"
import type { JsonObject } from "./blocks/json.ts"
import { isObject, lockEntries, object, readJson, stringRecord, writeJson } from "./blocks/json.ts"
import {
  installablePins,
  localRegistry,
  newInstallScripts,
  NAMESPACE,
  npmDependencies,
  parseBlock,
  registryProblems,
} from "./blocks/rules.ts"
import type { Block } from "./blocks/rules.ts"

const root = path.resolve(import.meta.dirname, "..")
const built = path.join(root, "registry", "dist", "r")
const shadcn = path.join(root, "node_modules", ".bin", "shadcn")
const cli = path.join(root, "packages", "create-botyard-app", "dist", "bin.js")
// CI only, as for the CLI build: see installablePins in blocks/rules.ts.
const allowUnpublishedBump = process.env["BOTYARD_ALLOW_UNPUBLISHED_BUMP"] === "1"

/** A built registry item: as served (`json`) and as the rules see it. */
type Item = { readonly json: JsonObject; readonly block: Block }

const work = await mkdtemp(path.join(os.tmpdir(), "check-blocks-"))
try {
  await main(process.argv.slice(2))
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
} finally {
  await rm(work, { recursive: true, force: true })
}

async function main(only: string[]): Promise<void> {
  const items = await readBuiltRegistry()
  const blocks = new Map([...items].map(([name, item]) => [name, item.block]))
  const problems = registryProblems(blocks)
  if (problems.length > 0) throw new Error(`registry/registry.json:\n  ${problems.join("\n  ")}`)

  const names = only.length > 0 ? only : [...items.keys()]
  for (const name of names) {
    if (!items.has(name)) throw new Error(`no block "${name}" in registry/registry.json`)
  }

  const server = await serve(items, await readJson(path.join(built, "registry.json")))
  try {
    for (const name of names) {
      print(`::group::block ${name}`)
      await checkBlock(name, blocks, server.url)
      print("::endgroup::")
    }
  } finally {
    server.close()
  }
}

/**
 * Reads every item from registry/dist/r, which `pnpm run build` writes and
 * registry.yml publishes, so the files checked are the files published.
 */
async function readBuiltRegistry(): Promise<Map<string, Item>> {
  const source = object(
    await readJson(path.join(root, "registry", "registry.json")),
    "registry.json"
  )
  if (!Array.isArray(source["items"])) throw new Error("registry.json items is not a list")
  const items = new Map<string, Item>()
  for (const [i, entry] of source["items"].entries()) {
    const { name } = parseBlock(entry, `registry.json items[${i}]`)
    const file = path.join(built, `${name}.json`)
    let json: unknown
    try {
      json = await readJson(file)
    } catch (err) {
      throw new Error(`cannot read ${file}; run \`pnpm run build\` first`, { cause: err })
    }
    items.set(name, { json: object(json, file), block: parseBlock(json, file) })
  }
  return items
}

/**
 * Serves each item at /r/<name>.json without its npm dependencies (see 4.),
 * and the index `shadcn search` reads at /r/registry.json.
 */
async function serve(
  items: ReadonlyMap<string, Item>,
  index: unknown
): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    // Like a static host, ignore the query: `shadcn search` adds ?limit=&offset=.
    const [pathname = ""] = (req.url ?? "").split("?")
    if (pathname === "/r/registry.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(index))
      return
    }
    const name = /^\/r\/([a-z0-9-]+)\.json$/.exec(pathname)?.[1]
    const item = name === undefined ? undefined : items.get(name)
    if (item === undefined) {
      res.writeHead(404).end()
      return
    }
    const served = Object.fromEntries(
      Object.entries(item.json).filter(
        ([key]) => key !== "dependencies" && key !== "devDependencies"
      )
    )
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(served))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the server has no port")
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() }
}

async function checkBlock(
  name: string,
  blocks: ReadonlyMap<string, Block>,
  registryOrigin: string
): Promise<void> {
  const app = path.join(work, "apps", name)
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" }
  await run(process.execPath, [cli, app, "--name", "blocks-check"], { cwd: root })

  const pkgFile = path.join(app, "package.json")
  const lockFile = path.join(app, "package-lock.json")
  const pkg = object(await readJson(pkgFile), pkgFile)
  const generatedLock = lockEntries(await readJson(lockFile), lockFile)

  const pins = installablePins(
    stringRecord(pkg["dependencies"], `${pkgFile} dependencies`),
    generatedLock,
    {
      allowUnpublishedBump,
    }
  )
  for (const change of pins.rolledBack) {
    print(`::notice::Not on npm yet, so checked at the published version: ${change}`)
  }
  const dependencies = pins.dependencies
  const devDependencies = stringRecord(pkg["devDependencies"], `${pkgFile} devDependencies`)

  const componentsFile = path.join(app, "components.json")
  const components = object(await readJson(componentsFile), componentsFile)
  await writeJson(componentsFile, {
    ...components,
    registries: { [NAMESPACE]: localRegistry(components, registryOrigin) },
  })

  const needs = npmDependencies(name, blocks)
  for (const [field, added] of [
    [dependencies, needs.dependencies],
    [devDependencies, needs.devDependencies],
  ] as const) {
    for (const [dep, version] of added) {
      const existing = dependencies[dep] ?? devDependencies[dep]
      if (existing !== undefined && existing !== version) {
        throw new Error(`${name} needs ${dep}@${version}; the template has ${existing}`)
      }
      field[dep] = version
    }
  }
  await writeJson(pkgFile, { ...pkg, dependencies, devDependencies })
  if (needs.dependencies.size + needs.devDependencies.size > 0) {
    await run(path.join(root, "scripts", "lock-template.sh"), ["--app", app], { cwd: root })
    const scripts = newInstallScripts(
      generatedLock,
      lockEntries(await readJson(lockFile), lockFile)
    )
    if (scripts.length > 0) throw new Error(`install scripts in ${scripts.join(", ")}`)
  }

  await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app, env })

  const stubs = await packageManagerStubs()
  const pkgBefore = await readFile(pkgFile, "utf8")
  await run(shadcn, ["add", `${NAMESPACE}/${name}`, "--yes"], {
    cwd: app,
    env: { ...env, PATH: `${stubs}${path.delimiter}${env["PATH"] ?? ""}` },
  })
  if ((await readFile(pkgFile, "utf8")) !== pkgBefore) {
    throw new Error(`shadcn add ${NAMESPACE}/${name} changed package.json`)
  }
  if (!(await searchFinds(app, `${NAMESPACE}/${name}`))) {
    throw new Error(`shadcn search ${NAMESPACE} does not list ${NAMESPACE}/${name}`)
  }

  for (const script of ["lint", "format:check", "typecheck", "test", "build"]) {
    await run("npm", ["run", script], { cwd: app, env })
  }
}

/** Whether `shadcn search @botyard`, run in the app, lists `address`. */
async function searchFinds(app: string, address: string): Promise<boolean> {
  const { stdout } = await promisify(execFile)(shadcn, ["search", NAMESPACE, "--json"], {
    cwd: app,
  })
  const items: unknown = object(JSON.parse(stdout), "shadcn search output")["items"]
  return (
    Array.isArray(items) &&
    items.some((item: unknown) => isObject(item) && item["addCommandArgument"] === address)
  )
}

/** A directory of npm, pnpm, yarn and bun stubs that fail when run. */
async function packageManagerStubs(): Promise<string> {
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

function print(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** Runs a command with inherited output; rejects unless it exits 0. */
function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} ${args.join(" ")} exited with ${code}`))
    })
  })
}

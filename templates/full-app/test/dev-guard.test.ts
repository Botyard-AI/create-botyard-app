import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer as createHttpServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer as createVite, type ViteDevServer } from "vite"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { isPrivate, keepPrivate, refusePrivate } from "../server/dev-guard.ts"

let dir: string
let root: string
let trace: string
let rotated: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "full-app-guard-"))
  root = path.join(dir, "app")
  await mkdir(path.join(root, "data"), { recursive: true })
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "data", "store.json"), '{"store":"store-marker"}')
  await writeFile(path.join(root, "src", "main.ts"), 'export const ui = "ui-marker"\n')
  // An earlier run's trace, outside the app.
  trace = path.join(dir, "trace.jsonl")
  rotated = path.join(dir, "trace.1.jsonl")
  await writeFile(trace, '{"event":"active-marker"}\n')
  await writeFile(rotated, '{"event":"rotated-marker"}\n')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("isPrivate", () => {
  test("data/ and the trace files are private, by any name; the rest is not", async () => {
    await symlink(path.join(root, "data", "store.json"), path.join(root, "src", "a.txt"))
    await symlink(trace, path.join(root, "src", "b.txt"))
    await symlink(path.join(root, "data"), path.join(root, "d"))
    const at = { root, files: [trace, rotated] }
    expect(isPrivate(at, path.join(root, "data", "store.json"))).toBe(true)
    expect(isPrivate(at, path.join(root, "src", "a.txt"))).toBe(true)
    expect(isPrivate(at, path.join(root, "src", "b.txt"))).toBe(true)
    expect(isPrivate(at, path.join(root, "d", "store.json"))).toBe(true)
    expect(isPrivate(at, trace)).toBe(true)
    expect(isPrivate(at, path.join(root, "src", "main.ts"))).toBe(false)
    expect(isPrivate(at, path.join(root, "src", "missing.ts"))).toBe(false)
  })

  test("trace files given by an alias of their directory are matched by where they are", async () => {
    await symlink(dir, path.join(dir, "..", `${path.basename(dir)}-alias`))
    const aliased = path.join(dir, "..", `${path.basename(dir)}-alias`, "trace.jsonl")
    try {
      await symlink(trace, path.join(root, "src", "b.txt"))
      expect(isPrivate({ root, files: [aliased] }, path.join(root, "src", "b.txt"))).toBe(true)
    } finally {
      await rm(path.join(dir, "..", `${path.basename(dir)}-alias`), { force: true })
    }
  })

  test("a rotated file that appears later is private too", async () => {
    await rm(rotated)
    const at = { root, files: [trace, rotated] }
    await symlink(rotated, path.join(root, "src", "c.txt"))
    expect(isPrivate(at, path.join(root, "src", "c.txt"))).toBe(false)
    await writeFile(rotated, "")
    expect(isPrivate(at, path.join(root, "src", "c.txt"))).toBe(true)
  })

  test("never throws when data/ or a trace name cannot be resolved", async () => {
    // data/ a symlink to itself: a loop, which nothing can be opened through.
    await rm(path.join(root, "data"), { recursive: true })
    await symlink(path.join(root, "data"), path.join(root, "data"))
    const loop = path.join(dir, "loop.jsonl")
    await symlink(loop, loop)
    const at = { root, files: [loop, trace] }
    expect(isPrivate(at, path.join(root, "src", "main.ts"))).toBe(false)
    expect(isPrivate(at, path.join(root, "data", "store.json"))).toBe(false)
    expect(isPrivate(at, trace)).toBe(true)
  })
})

test("refusePrivate refuses a private module whatever its query, and passes the rest", async () => {
  await symlink(trace, path.join(root, "src", "b.txt"))
  const at = { root, files: [trace] }
  expect(() => refusePrivate(at, `${path.join(root, "src", "b.txt")}?raw`)).toThrow("private")
  expect(() => refusePrivate(at, path.join(root, "data", "store.json"))).toThrow("private")
  expect(refusePrivate(at, path.join(root, "src", "main.ts"))).toBeNull()
  expect(refusePrivate(at, "\0virtual:thing")).toBeNull()
})

describe("through a real Vite dev server", () => {
  let vite: ViteDevServer
  let http: Server
  let base: string
  const start = async (files: readonly string[]): Promise<void> => {
    vite = await createVite({
      root,
      configFile: false,
      logLevel: "silent",
      appType: "spa",
      server: { middlewareMode: true, hmr: false },
      plugins: [keepPrivate({ root, files })],
    })
    http = createHttpServer((req, res) => {
      vite.middlewares(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })
    await new Promise<void>((resolve) => {
      http.listen(0, "127.0.0.1", () => {
        resolve()
      })
    })
    const address = http.address()
    base = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`
  }
  afterEach(async () => {
    await vite.close()
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve()
      })
    })
  })

  test("an earlier run's trace files stay private; the UI is served", async () => {
    await symlink(trace, path.join(root, "src", "active.txt"))
    await symlink(rotated, path.join(root, "src", "rotated.txt"))
    await start([trace, rotated])
    for (const name of ["active", "rotated"]) {
      for (const query of ["", "?raw", "?import", "?url", "?inline"]) {
        const text = await (await fetch(`${base}/src/${name}.txt${query}`)).text()
        expect(text, `${name}${query}`).not.toMatch(/active-marker|rotated-marker/)
      }
    }
    const ui = await fetch(`${base}/src/main.ts`)
    expect(ui.status).toBe(200)
    expect(await ui.text()).toContain("ui-marker")
  })

  test("the UI is served when data/ cannot be resolved", async () => {
    await rm(path.join(root, "data"), { recursive: true })
    await symlink(path.join(root, "data"), path.join(root, "data"))
    await start([trace, rotated])
    const ui = await fetch(`${base}/src/main.ts`)
    expect(ui.status).toBe(200)
    expect(await ui.text()).toContain("ui-marker")
  })

  test("the load hook is registered: a transform of a private module is refused", async () => {
    // Into data/, which this bare server's own fs checks allow (it has no deny
    // list), so only the hook stands in the way.
    await symlink(path.join(root, "data", "store.json"), path.join(root, "src", "b.txt"))
    await start([trace])
    await expect(vite.transformRequest("/src/b.txt?raw")).rejects.toThrow("private")
    expect((await vite.transformRequest("/src/main.ts"))?.code).toContain("ui-marker")
  })
})

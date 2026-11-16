import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { asViewer, startApp } from "./helpers.ts"

describe("/api/me", () => {
  test("a member of the org", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/me`, asViewer("ada@example.com"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toMatchObject({
      viewer: { kind: "member", userId: "user-ada", name: "Ada Lovelace", role: "owner" },
    })
  })

  test("matches email case-insensitively", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/me`, asViewer("Grace@Example.com"))
    expect(await res.json()).toMatchObject({ viewer: { kind: "member", userId: "user-grace" } })
  })

  test("someone signed in who is not in the org", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/me`, asViewer("mallory@example.org"))
    expect(await res.json()).toMatchObject({
      viewer: { kind: "unknown", email: "mallory@example.org" },
    })
  })

  test("nobody signed in", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/me`)
    expect(await res.json()).toEqual({ viewer: null })
  })

  test("ignores identity headers the Bot Page proxy never sets", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/me`, { headers: { "x-user-email": "ada@example.com" } })
    expect(await res.json()).toEqual({ viewer: null })
  })
})

describe("/api/hello (members only)", () => {
  test("greets a member", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/hello`, asViewer("ada@example.com"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: "Hello, Ada Lovelace!" })
  })

  test("refuses someone outside the org", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/hello`, asViewer("mallory@example.org"))
    expect(res.status).toBe(403)
  })

  test("refuses an anonymous request", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/hello`)
    expect(res.status).toBe(401)
  })
})

describe("routing", () => {
  test("health", async () => {
    const base = await startApp()
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true })
  })

  test("an unknown API route is a JSON 404", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not_found" })
  })

  test("only GET and HEAD reach the UI", async () => {
    const base = await startApp()
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405)
  })

  test("the dev UI middleware gets UI requests, not API ones", async () => {
    const seen: string[] = []
    const base = await startApp({
      ui: (req, res) => {
        seen.push(req.url ?? "")
        res.end("vite")
      },
    })
    expect(await (await fetch(`${base}/some/page`)).text()).toBe("vite")
    await fetch(`${base}/api/health`)
    expect(seen).toEqual(["/some/page"])
  })
})

describe("serving the built UI", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "full-app-static-"))
    await mkdir(path.join(dir, "client", "assets"), { recursive: true })
    await writeFile(path.join(dir, "client", "index.html"), "<!doctype html>app")
    await writeFile(path.join(dir, "client", "assets", "index-abc.js"), "console.log(1)")
    await writeFile(path.join(dir, "secret.txt"), "outside the UI")
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("index.html, assets and client-side routes", async () => {
    const base = await startApp({ staticDir: path.join(dir, "client") })

    const index = await fetch(`${base}/`)
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(index.headers.get("cache-control")).toBe("no-cache")
    expect(await index.text()).toBe("<!doctype html>app")

    const asset = await fetch(`${base}/assets/index-abc.js`)
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(asset.headers.get("cache-control")).toContain("immutable")

    expect(await (await fetch(`${base}/quotes/42`)).text()).toBe("<!doctype html>app")
    expect((await fetch(`${base}/missing.png`)).status).toBe(404)
  })

  test("never follows a symlink out of the UI directory", async () => {
    const client = path.join(dir, "client")
    await symlink(path.join(dir, "secret.txt"), path.join(client, "assets", "linked.txt"))
    await symlink(dir, path.join(client, "up"))
    try {
      const base = await startApp({ staticDir: client })
      for (const probe of ["/assets/linked.txt", "/up/secret.txt"]) {
        const res = await fetch(`${base}${probe}`)
        expect(res.status, probe).toBe(404)
        expect(await res.text(), probe).not.toContain("outside the UI")
      }
    } finally {
      await rm(path.join(client, "assets", "linked.txt"))
      await rm(path.join(client, "up"))
    }
  })

  test.skipIf(process.getuid?.() === 0)(
    "an unreadable file is a 404, and the server keeps serving",
    async () => {
      const locked = path.join(dir, "client", "locked.txt")
      await writeFile(locked, "no")
      await chmod(locked, 0o000)
      try {
        const base = await startApp({ staticDir: path.join(dir, "client") })
        expect((await fetch(`${base}/locked.txt`)).status).toBe(404)
        expect((await fetch(`${base}/`)).status).toBe(200)
      } finally {
        await rm(locked, { force: true })
      }
    }
  )

  test("HEAD sends headers without a body", async () => {
    const base = await startApp({ staticDir: path.join(dir, "client") })
    const res = await fetch(`${base}/`, { method: "HEAD" })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("")
  })

  test("never serves files outside the UI directory", async () => {
    const base = await startApp({ staticDir: path.join(dir, "client") })
    for (const probe of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2F..%2Fsecret.txt"]) {
      const res = await fetch(`${base}${probe}`)
      expect(await res.text(), probe).not.toContain("outside the UI")
    }
  })
})

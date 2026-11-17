import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Published, Registry } from "../scripts/pin.ts"
import { npmRegistry, pinWorkspaceDependencies, readWorkspaceVersions } from "../scripts/pin.ts"
import { readJson, tempDir } from "./helpers.ts"

const workspace = new Map([
  ["@botyard/runtime", "0.1.1"],
  ["@botyard/botpage", "0.1.0"],
])

/** A registry where each package's latest is `latest[name]`, with a made-up integrity per version. */
function fakeRegistry(latest: Record<string, string | undefined>): Registry {
  return async (name): Promise<Published> => ({
    latest: latest[name],
    integrity: (version) => `sha512-${name}@${version}`,
  })
}
const published = fakeRegistry({ "@botyard/runtime": "0.1.1", "@botyard/botpage": "0.1.0" })

async function template(pkg: object, lock?: object): Promise<string> {
  const dir = await tempDir()
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
  if (lock !== undefined) {
    await writeFile(path.join(dir, "package-lock.json"), JSON.stringify(lock))
  }
  return dir
}

function lockFor(entries: Record<string, { version: string; integrity: string }>): object {
  return {
    lockfileVersion: 3,
    packages: Object.fromEntries(
      Object.entries(entries).map(([name, entry]) => [`node_modules/${name}`, entry])
    ),
  }
}
const goodLock = lockFor({
  "@botyard/runtime": { version: "0.1.1", integrity: "sha512-@botyard/runtime@0.1.1" },
  "@botyard/botpage": { version: "0.1.0", integrity: "sha512-@botyard/botpage@0.1.0" },
})

describe("pinWorkspaceDependencies", () => {
  test("rewrites workspace:* to the exact published version", async () => {
    const dir = await template(
      {
        name: "t",
        dependencies: {
          "@botyard/runtime": "workspace:*",
          "@botyard/botpage": "workspace:*",
          react: "19.3.1",
        },
      },
      goodLock
    )
    const pinned = await pinWorkspaceDependencies(dir, workspace, published)
    expect(Object.fromEntries(pinned)).toEqual({
      "@botyard/runtime": "0.1.1",
      "@botyard/botpage": "0.1.0",
    })
    expect(await readJson(path.join(dir, "package.json"))).toEqual({
      name: "t",
      dependencies: { "@botyard/runtime": "0.1.1", "@botyard/botpage": "0.1.0", react: "19.3.1" },
    })
  })

  test("leaves a template without workspace dependencies byte for byte", async () => {
    const dir = await template({ name: "t", dependencies: { react: "19.3.1" } })
    const before = await readFile(path.join(dir, "package.json"), "utf8")
    expect((await pinWorkspaceDependencies(dir, workspace, published)).size).toBe(0)
    expect(await readFile(path.join(dir, "package.json"), "utf8")).toBe(before)
  })

  test.each([
    ["not published at all", fakeRegistry({}), /npm's latest is nothing/],
    [
      "published, but not as latest",
      fakeRegistry({ "@botyard/runtime": "0.1.0" }),
      /is 0\.1\.1 here but npm's latest is 0\.1\.0/,
    ],
  ])("fails when the version is %s", async (_label, registry, message) => {
    const dir = await template({ dependencies: { "@botyard/runtime": "workspace:*" } })
    await expect(pinWorkspaceDependencies(dir, workspace, registry)).rejects.toThrow(message)
    // Nothing half-written.
    expect(await readJson(path.join(dir, "package.json"))).toEqual({
      dependencies: { "@botyard/runtime": "workspace:*" },
    })
  })

  test("fails on a workspace range other than *", async () => {
    const dir = await template({ dependencies: { "@botyard/runtime": "workspace:^" } })
    await expect(pinWorkspaceDependencies(dir, workspace, published)).rejects.toThrow(
      /templates use "workspace:\*"/
    )
  })

  test("fails on a package this repository does not publish", async () => {
    const dir = await template({ devDependencies: { "@botyard/eslint-config": "workspace:*" } })
    await expect(pinWorkspaceDependencies(dir, workspace, published)).rejects.toThrow(
      /not a publishable package/
    )
  })

  test.each([
    [
      "another version",
      lockFor({
        "@botyard/runtime": { version: "0.1.0", integrity: "sha512-@botyard/runtime@0.1.0" },
      }),
    ],
    [
      "another integrity",
      lockFor({ "@botyard/runtime": { version: "0.1.1", integrity: "sha512-tampered" } }),
    ],
    ["no entry", lockFor({})],
  ])("fails when the lockfile has %s", async (_label, lock) => {
    const dir = await template({ dependencies: { "@botyard/runtime": "workspace:*" } }, lock)
    await expect(pinWorkspaceDependencies(dir, workspace, published)).rejects.toThrow(
      /does not lock @botyard\/runtime@0\.1\.1 as published/
    )
  })
})

test("readWorkspaceVersions lists publishable packages only", async () => {
  const root = await tempDir()
  const write = async (dir: string, pkg: object): Promise<void> => {
    await mkdir(path.join(root, "packages", dir), { recursive: true })
    await writeFile(path.join(root, "packages", dir, "package.json"), JSON.stringify(pkg))
  }
  await write("runtime", { name: "@botyard/runtime", version: "0.1.1" })
  await write("internal", { name: "@botyard/internal", version: "1.0.0", private: true })
  expect(Object.fromEntries(await readWorkspaceVersions(root))).toEqual({
    "@botyard/runtime": "0.1.1",
  })
})

describe("npmRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("asks for abbreviated metadata with the scope's slash escaped", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        "dist-tags": { latest: "0.1.1" },
        versions: { "0.1.1": { dist: { integrity: "sha512-abc" } } },
      })
    )
    vi.stubGlobal("fetch", fetchMock)
    const published = await npmRegistry("https://registry.example")("@botyard/runtime")
    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.example/@botyard%2fruntime",
      expect.objectContaining({ headers: { accept: "application/vnd.npm.install-v1+json" } })
    )
    expect(published.latest).toBe("0.1.1")
    expect(published.integrity("0.1.1")).toBe("sha512-abc")
    expect(published.integrity("0.1.0")).toBeUndefined()
  })

  test("reports an unpublished package as having no latest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
    )
    expect((await npmRegistry()("@botyard/nothing")).latest).toBeUndefined()
  })

  test("fails on other HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    )
    await expect(npmRegistry()("@botyard/runtime")).rejects.toThrow(/HTTP 503/)
  })
})

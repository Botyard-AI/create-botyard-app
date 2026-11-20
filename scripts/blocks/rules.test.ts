import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { LockEntry } from "./json.ts"
import { lockEntries } from "./json.ts"
import {
  installablePins,
  npmDependencies,
  parseBlock,
  registryProblems,
  splitSpec,
} from "./rules.ts"
import type { Block } from "./rules.ts"

function registry(items: Record<string, Partial<Block>>): Map<string, Block> {
  return new Map(
    Object.entries(items).map(([name, item]) => [name, parseBlock({ name, ...item }, name)])
  )
}

describe("registryProblems", () => {
  it("accepts exact versions and @botyard blocks", () => {
    const blocks = registry({
      chart: { dependencies: ["recharts@3.2.1", "@scope/pkg@1.0.0-beta.1"] },
      dashboard: { registryDependencies: ["@botyard/chart"], devDependencies: ["x@0.0.1"] },
    })
    assert.deepEqual(registryProblems(blocks), [])
  })

  it("rejects ranges and bare names", () => {
    const blocks = registry({ chart: { dependencies: ["recharts", "zod@^4.0.0", "a@latest"] } })
    assert.equal(registryProblems(blocks).length, 3)
  })

  it("rejects shadcn/ui components, URLs and unknown blocks", () => {
    const blocks = registry({
      chart: {
        registryDependencies: [
          "button",
          "https://example.com/r/x.json",
          "@acme/chart",
          "@botyard/missing",
        ],
      },
    })
    assert.deepEqual(registryProblems(blocks), [
      'chart: registryDependencies "button" must be a @botyard block',
      'chart: registryDependencies "https://example.com/r/x.json" must be a @botyard block',
      'chart: registryDependencies "@acme/chart" must be a @botyard block',
      'chart: registryDependencies "@botyard/missing" is not in registry.json',
    ])
  })

  it("keeps file targets under server, src and test", () => {
    const files = (target: string) => [
      { path: "registry/blocks/x/a.ts", type: "registry:file", target },
    ]
    for (const ok of ["~/server/a.ts", "~/test/ui/a.test.tsx", "~/src/lib/a.ts"]) {
      assert.deepEqual(
        registryProblems(new Map([["x", parseBlock({ name: "x", files: files(ok) }, "x")]])),
        [],
        ok
      )
    }
    for (const bad of [
      "~/package.json",
      "~/.npmrc",
      "~/.env",
      "~/server/../.npmrc",
      "../x.ts",
      "/etc/x",
      "server/a.ts",
    ]) {
      const problems = registryProblems(
        new Map([["x", parseBlock({ name: "x", files: files(bad) }, "x")]])
      )
      assert.equal(problems.length, 1, bad)
    }
  })

  it("rejects fields that change more than the block's own files", () => {
    const block = parseBlock({ name: "x", envVars: { A: "1" }, cssVars: {}, css: {} }, "x")
    assert.equal(registryProblems(new Map([["x", block]])).length, 3)
  })

  it("rejects names a URL could not hold", () => {
    assert.equal(registryProblems(registry({ "../x": {} })).length, 1)
    assert.equal(registryProblems(registry({ Chart: {} })).length, 1)
  })
})

describe("parseBlock", () => {
  it("refuses fields of the wrong shape", () => {
    assert.throws(() => parseBlock({ name: "x", dependencies: "zod@4.1.12" }, "x"), /not a list/)
    assert.throws(() => parseBlock({ name: "x", dependencies: [1] }, "x"), /not a string/)
    assert.throws(() => parseBlock([], "x"), /not an object/)
  })
})

describe("npmDependencies", () => {
  it("collects the dependencies of the blocks a block depends on", () => {
    const blocks = registry({
      dashboard: { registryDependencies: ["@botyard/chart"], dependencies: ["zod@4.1.12"] },
      chart: { registryDependencies: ["@botyard/dashboard"], devDependencies: ["x@1.0.0"] },
    })
    const deps = npmDependencies("dashboard", blocks)
    assert.deepEqual([...deps.dependencies], [["zod", "4.1.12"]])
    assert.deepEqual([...deps.devDependencies], [["x", "1.0.0"]])
  })

  it("fails when two blocks pin different versions", () => {
    const blocks = registry({
      a: { registryDependencies: ["@botyard/b"], dependencies: ["zod@4.1.12"] },
      b: { dependencies: ["zod@4.1.11"] },
    })
    assert.throws(() => npmDependencies("a", blocks), /zod is pinned to both/)
  })
})

describe("installablePins", () => {
  const published = (version: string): LockEntry => ({
    version,
    resolved: `https://registry.npmjs.org/@botyard/runtime/-/runtime-${version}.tgz`,
    integrity: "sha512-abc",
    hasInstallScript: false,
  })
  const lock = new Map([["node_modules/@botyard/runtime", published("0.1.2")]])
  const allow = { allowUnpublishedBump: true }
  const strict = { allowUnpublishedBump: false }

  it("keeps pins that match the lockfile", () => {
    const deps = { "@botyard/runtime": "0.1.2", zod: "4.1.12" }
    assert.deepEqual(installablePins(deps, lock, strict), { dependencies: deps, rolledBack: [] })
  })

  it("rolls an unpublished bump back to the locked version, in CI only", () => {
    const deps = { "@botyard/runtime": "0.1.3" }
    assert.deepEqual(installablePins(deps, lock, allow), {
      dependencies: { "@botyard/runtime": "0.1.2" },
      rolledBack: ["@botyard/runtime@0.1.3 -> 0.1.2"],
    })
    assert.throws(() => installablePins(deps, lock, strict), /not what package-lock.json locks/)
  })

  it("never rolls back to a version that is not locked from npm", () => {
    const deps = { "@botyard/runtime": "0.1.3" }
    assert.throws(() => installablePins(deps, new Map(), allow), /no published version/)
    const local = new Map([
      ["node_modules/@botyard/runtime", { ...published("0.1.2"), resolved: "file:x.tgz" }],
    ])
    assert.throws(() => installablePins(deps, local, allow), /no published version/)
  })

  it("leaves other packages to the lockfile rules", () => {
    const deps = { zod: "9.9.9" }
    assert.deepEqual(installablePins(deps, lock, strict).dependencies, deps)
  })
})

describe("lockEntries", () => {
  it("reads entries and refuses a malformed one", () => {
    const entries = lockEntries(
      { packages: { "node_modules/a": { version: "1.0.0", hasInstallScript: true } } },
      "lock"
    )
    assert.equal(entries.get("node_modules/a")?.hasInstallScript, true)
    assert.throws(
      () => lockEntries({ packages: { a: { hasInstallScript: "yes" } } }, "lock"),
      /not a boolean/
    )
    assert.throws(() => lockEntries({}, "lock"), /packages is not an object/)
  })
})

describe("splitSpec", () => {
  it("splits scoped and unscoped names", () => {
    assert.deepEqual(splitSpec("@scope/pkg@1.2.3"), ["@scope/pkg", "1.2.3"])
    assert.deepEqual(splitSpec("pkg@1.2.3"), ["pkg", "1.2.3"])
  })
})

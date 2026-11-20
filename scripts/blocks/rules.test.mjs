import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { npmDependencies, registryProblems, splitSpec } from "./rules.mjs"

/** @param {Record<string, Record<string, unknown>>} items */
const registry = (items) => new Map(Object.entries(items))

describe("registryProblems", () => {
  it("accepts exact versions and @botyard blocks", () => {
    const items = registry({
      chart: { dependencies: ["recharts@3.2.1", "@scope/pkg@1.0.0-beta.1"] },
      dashboard: { registryDependencies: ["@botyard/chart"], devDependencies: ["x@0.0.1"] },
    })
    assert.deepEqual(registryProblems(items), [])
  })

  it("rejects ranges and bare names", () => {
    const items = registry({ chart: { dependencies: ["recharts", "zod@^4.0.0", "a@latest"] } })
    assert.equal(registryProblems(items).length, 3)
  })

  it("rejects shadcn/ui components and unknown blocks", () => {
    const items = registry({
      chart: { registryDependencies: ["button", "@acme/chart", "@botyard/missing"] },
    })
    assert.deepEqual(registryProblems(items), [
      'chart: registryDependencies "button" must be a @botyard block',
      'chart: registryDependencies "@acme/chart" must be a @botyard block',
      'chart: registryDependencies "@botyard/missing" is not in registry.json',
    ])
  })

  it("rejects names a URL could not hold", () => {
    assert.equal(registryProblems(registry({ "../x": {} })).length, 1)
    assert.equal(registryProblems(registry({ Chart: {} })).length, 1)
  })
})

describe("npmDependencies", () => {
  it("collects the dependencies of the blocks a block depends on", () => {
    const items = registry({
      dashboard: { registryDependencies: ["@botyard/chart"], dependencies: ["zod@4.1.12"] },
      chart: { registryDependencies: ["@botyard/dashboard"], devDependencies: ["x@1.0.0"] },
    })
    const deps = npmDependencies("dashboard", items)
    assert.deepEqual([...deps.dependencies], [["zod", "4.1.12"]])
    assert.deepEqual([...deps.devDependencies], [["x", "1.0.0"]])
  })

  it("fails when two blocks pin different versions", () => {
    const items = registry({
      a: { registryDependencies: ["@botyard/b"], dependencies: ["zod@4.1.12"] },
      b: { dependencies: ["zod@4.1.11"] },
    })
    assert.throws(() => npmDependencies("a", items), /zod is pinned to both/)
  })
})

describe("splitSpec", () => {
  it("splits scoped and unscoped names", () => {
    assert.deepEqual(splitSpec("@scope/pkg@1.2.3"), ["@scope/pkg", "1.2.3"])
    assert.deepEqual(splitSpec("pkg@1.2.3"), ["pkg", "1.2.3"])
  })
})

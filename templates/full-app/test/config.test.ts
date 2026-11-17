import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { ConfigError, loadConfig, parseConfig } from "../server/config.ts"

describe("parseConfig", () => {
  test("reads name and port", () => {
    expect(parseConfig({ name: "my-app", port: 8787 })).toEqual({ name: "my-app", port: 8787 })
  })

  test("PORT overrides the port", () => {
    expect(parseConfig({ name: "my-app", port: 8787 }, { PORT: "9000" })).toMatchObject({
      port: 9000,
    })
  })

  test.each([
    ["not an object", []],
    ["no name", { port: 8787 }],
    ["empty name", { name: "", port: 8787 }],
    ["long name", { name: "x".repeat(81), port: 8787 }],
    ["no port", { name: "a" }],
    ["port 0", { name: "a", port: 0 }],
    ["port too high", { name: "a", port: 65536 }],
    ["fractional port", { name: "a", port: 80.5 }],
    ["port as a string", { name: "a", port: "8787" }],
  ])("rejects %s", (_label, json) => {
    expect(() => parseConfig(json)).toThrow(ConfigError)
  })

  test("rejects a PORT that is not a number", () => {
    expect(() => parseConfig({ name: "a", port: 8787 }, { PORT: "80abc" })).toThrow(ConfigError)
  })
})

describe("loadConfig", () => {
  test("the template's own botyard.json is valid", async () => {
    await expect(loadConfig(undefined, {})).resolves.toMatchObject({ port: 8787 })
  })

  test("names the file it could not read", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "full-app-config-"))
    try {
      await writeFile(path.join(dir, "botyard.json"), "{ nope")
      await expect(loadConfig(dir, {})).rejects.toThrow(path.join(dir, "botyard.json"))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

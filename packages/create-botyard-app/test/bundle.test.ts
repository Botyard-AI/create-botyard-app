import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { bundleTemplates } from "../scripts/bundle.ts"
import { listFiles, run, tempDir } from "./helpers.ts"

async function write(file: string, text = ""): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

describe("bundleTemplates", () => {
  test("bundles what the app needs, and the CLI restores it", async () => {
    const root = await tempDir()
    const app = path.join(root, "templates", "app")
    await write(path.join(root, "shared", "config.js"), "export default {}\n")
    await write(path.join(app, "package.json"), `{ "name": "t" }`)
    await write(path.join(app, ".gitignore"), "node_modules/\n")
    await write(path.join(app, ".npmrc"), "engine-strict=true\n")
    await write(path.join(app, ".env.example"), "PORT=\n")
    await write(path.join(app, "src", "main.ts"))
    for (const skipped of [
      "node_modules/x/index.js",
      "dist/index.js",
      "coverage/lcov.info",
      "src/node_modules/y.js",
      ".env",
      ".env.local",
      "tsconfig.tsbuildinfo",
    ]) {
      await write(path.join(app, skipped))
    }
    await symlink("../../shared", path.join(app, "shared"))

    const out = path.join(root, "pkg", "templates")
    expect(
      await bundleTemplates({ sourceDir: path.join(root, "templates"), outDir: out, root })
    ).toEqual(["app"])
    expect(await listFiles(path.join(out, "app"))).toEqual([
      ".env.example",
      "gitignore",
      "npmrc",
      "package.json",
      "shared/config.js",
      "src/main.ts",
    ])

    const cwd = await tempDir()
    const result = await run(["made", "--template", "app"], { cwd, templatesDir: out })
    expect(result.code).toBe(0)
    expect(await listFiles(path.join(cwd, "made"))).toEqual([
      ".env.example",
      ".gitignore",
      ".npmrc",
      "package.json",
      "shared/config.js",
      "src/main.ts",
    ])
  })

  test("replaces an earlier bundle", async () => {
    const root = await tempDir()
    await write(path.join(root, "templates", "a", "x.txt"))
    const out = path.join(root, "out")
    await write(path.join(out, "stale", "y.txt"))
    await bundleTemplates({ sourceDir: path.join(root, "templates"), outDir: out, root })
    expect(await listFiles(out)).toEqual(["a/x.txt"])
  })

  test("no templates directory bundles nothing", async () => {
    const root = await tempDir()
    const out = path.join(root, "out")
    expect(
      await bundleTemplates({ sourceDir: path.join(root, "none"), outDir: out, root })
    ).toEqual([])
    expect(await listFiles(out)).toEqual([])
  })

  test("refuses a symlink that leaves the root", async () => {
    const root = await tempDir()
    const outside = await tempDir()
    await write(path.join(outside, "secret.txt"), "no")
    await write(path.join(root, "templates", "a", "x.txt"))
    await symlink(path.join(outside, "secret.txt"), path.join(root, "templates", "a", "secret.txt"))
    await expect(
      bundleTemplates({
        sourceDir: path.join(root, "templates"),
        outDir: path.join(root, "out"),
        root,
      })
    ).rejects.toThrow(/resolves outside/)
  })

  test("refuses a symlink cycle", async () => {
    const root = await tempDir()
    await write(path.join(root, "templates", "a", "x.txt"))
    await symlink("..", path.join(root, "templates", "a", "loop"))
    await expect(
      bundleTemplates({
        sourceDir: path.join(root, "templates"),
        outDir: path.join(root, "out"),
        root,
      })
    ).rejects.toThrow(/links back to/)
  })
})

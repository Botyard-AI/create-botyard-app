import { cp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { DEFAULT_TEMPLATE } from "../src/cli.ts"
import { fixtureTemplates, listFiles, readJson, run, tempDir } from "./helpers.ts"

const basic = ["--template", "basic"]

describe("scaffolding", () => {
  test("copies the template into a new directory and names the app", async () => {
    const cwd = await tempDir()
    const result = await run(["my-app", ...basic], { cwd })

    expect(result).toMatchObject({ code: 0, stderr: "" })
    const app = path.join(cwd, "my-app")
    expect(await listFiles(app)).toEqual([
      ".gitignore",
      ".npmrc",
      "botyard.json",
      "package.json",
      "src/index.js",
    ])
    expect(await readJson(path.join(app, "package.json"))).toEqual({
      name: "my-app",
      private: true,
      version: "0.0.0",
    })
    expect(await readJson(path.join(app, "botyard.json"))).toEqual({ name: "my-app", port: 8787 })
    expect(await readFile(path.join(app, ".gitignore"), "utf8")).toBe("node_modules/\n")
    expect(result.stdout).toContain("Created my-app in my-app from the basic template.")
    expect(result.stdout).toContain("  cd my-app\n  npm install\n  npm test\n  npm run dev\n")
  })

  test("creates missing parent directories", async () => {
    const cwd = await tempDir()
    const result = await run(["apps/web/my-app", ...basic], { cwd })
    expect(result.code).toBe(0)
    expect(await listFiles(path.join(cwd, "apps/web/my-app"))).toContain("package.json")
    expect(result.stdout).toContain("cd apps/web/my-app")
  })

  test("uses an existing empty directory, including the current one", async () => {
    const cwd = await tempDir()
    const app = path.join(cwd, "my-app")
    await mkdir(app)
    const result = await run([".", ...basic], { cwd: app })
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain("cd ")
    expect(await readJson(path.join(app, "package.json"))).toMatchObject({ name: "my-app" })
  })

  test("quotes a directory the shell would split", async () => {
    const cwd = await tempDir()
    const result = await run(["it's here/my-app", ...basic], { cwd })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`cd 'it'\\''s here/my-app'`)
  })

  test("--name names the package; the page gets the unscoped name", async () => {
    const cwd = await tempDir()
    const result = await run(["My App", "--name", "@acme/quotes", ...basic], { cwd })
    expect(result.code).toBe(0)
    const app = path.join(cwd, "My App")
    expect(await readJson(path.join(app, "package.json"))).toMatchObject({ name: "@acme/quotes" })
    expect(await readJson(path.join(app, "botyard.json"))).toMatchObject({ name: "quotes" })
  })

  test("leaves files a template does not have alone", async () => {
    const cwd = await tempDir()
    const result = await run(["docs", "--template", "other"], { cwd })
    expect(result.code).toBe(0)
    expect(await listFiles(path.join(cwd, "docs"))).toEqual(["README.md"])
  })
})

describe("refusals", () => {
  test("refuses a non-empty directory and changes nothing", async () => {
    const cwd = await tempDir()
    const app = path.join(cwd, "my-app")
    await mkdir(app)
    await writeFile(path.join(app, "package.json"), "mine")

    const result = await run(["my-app", ...basic], { cwd })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("is not empty")
    expect(await listFiles(app)).toEqual(["package.json"])
    expect(await readFile(path.join(app, "package.json"), "utf8")).toBe("mine")
  })

  test("refuses a path that is a file", async () => {
    const cwd = await tempDir()
    await writeFile(path.join(cwd, "my-app"), "")
    const result = await run(["my-app", ...basic], { cwd })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("exists and is not a directory")
  })

  test("refuses an unknown template, lists the bundled ones and creates nothing", async () => {
    const cwd = await tempDir()
    const result = await run(["my-app", "--template", "../basic"], { cwd })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown template "../basic". Available: basic, other.')
    expect(await readdir(cwd)).toEqual([])
  })

  test("the default template is full-app", async () => {
    const cwd = await tempDir()
    const result = await run(["my-app"], { cwd })
    expect(DEFAULT_TEMPLATE).toBe("full-app")
    expect(result.stderr).toContain(`Unknown template "full-app"`)
  })

  test("refuses a directory name that is not a package name, with a hint", async () => {
    const cwd = await tempDir()
    const result = await run(["My App", ...basic], { cwd })
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(
      `"My App" is not a valid npm package name: it must be lowercase. Pass --name <name> to choose another.\n`
    )
    expect(await readdir(cwd)).toEqual([])
  })

  test("refuses an invalid --name without the hint", async () => {
    const cwd = await tempDir()
    const result = await run(["my-app", "--name", "http", ...basic], { cwd })
    expect(result.code).toBe(2)
    expect(result.stderr).not.toContain("--name")
  })

  test("a template with a symlink fails before creating anything", async () => {
    const cwd = await tempDir()
    const templates = path.join(cwd, "templates")
    await cp(path.join(fixtureTemplates, "basic"), path.join(templates, "linked"), {
      recursive: true,
    })
    await symlink("/etc/passwd", path.join(templates, "linked", "src", "z-link"))

    const fresh = await run(["apps/my-app", "--template", "linked"], {
      cwd,
      templatesDir: templates,
    })
    expect(fresh.code).toBe(1)
    expect(fresh.stderr).toContain("is not a regular file or directory")
    expect(await readdir(cwd)).toEqual(["templates"])

    const existing = path.join(cwd, "existing")
    await mkdir(existing)
    const again = await run(["existing", "--template", "linked"], { cwd, templatesDir: templates })
    expect(again.code).toBe(1)
    expect((await stat(existing)).isDirectory()).toBe(true)
    expect(await readdir(existing)).toEqual([])
  })
})

describe("arguments", () => {
  test.each([[[]], [["a", "b"]], [[""]]])("needs exactly one directory: %j", async (argv) => {
    const result = await run(argv, { cwd: await tempDir() })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("Expected exactly one directory.")
    expect(result.stderr).toContain("Usage: create-botyard-app")
  })

  test("rejects unknown options", async () => {
    const result = await run(["my-app", "--force"], { cwd: await tempDir() })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("--force")
  })

  test("--help prints usage", async () => {
    const result = await run(["--help"], { cwd: await tempDir() })
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(result.stdout).toContain("It downloads nothing and installs nothing.")
  })

  test("--version prints the package version", async () => {
    const pkg = await readJson(new URL("../package.json", import.meta.url).pathname)
    const result = await run(["-v"], { cwd: await tempDir() })
    expect(pkg).toMatchObject({ version: result.stdout.trim() })
    expect(result).toMatchObject({ code: 0, stderr: "" })
  })

  test("--list-templates lists the bundled templates", async () => {
    const result = await run(["--list-templates"], { cwd: await tempDir() })
    expect(result).toEqual({ code: 0, stdout: "basic\nother\n", stderr: "" })
  })
})

// Deterministic interleavings with another process writing to the same target,
// driven through the scaffolder's hooks.
import { mkdir, readdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { scaffold, ScaffoldError } from "../src/scaffold.ts"
import { fixtureTemplates, listFiles, tempDir } from "./helpers.ts"

const base = { templatesDir: fixtureTemplates, template: "basic", packageName: "my-app" }

/** Throws on the n-th created entry, after letting `meddle` run there. */
function failAt(n: number, meddle: (file: string) => Promise<void> = async () => {}) {
  let count = 0
  return async (file: string): Promise<void> => {
    count += 1
    if (count === n) {
      await meddle(file)
      throw new Error("boom")
    }
  }
}

describe("rollback", () => {
  test("removes everything it created, including the target", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    await expect(
      scaffold({ ...base, targetDir, hooks: { afterCreate: failAt(4) } })
    ).rejects.toThrow("boom")
    expect(await readdir(cwd)).toEqual([])
  })

  test("keeps an empty target it was given", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    await mkdir(targetDir)
    await expect(
      scaffold({ ...base, targetDir, hooks: { afterCreate: failAt(4) } })
    ).rejects.toThrow("boom")
    expect(await readdir(targetDir)).toEqual([])
  })

  test("keeps files another process added, and the directories holding them", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const meddle = async (): Promise<void> => {
      await writeFile(path.join(targetDir, "theirs.txt"), "theirs")
      await writeFile(path.join(targetDir, "src", "theirs.js"), "theirs")
    }
    // Plan order: .gitignore, .npmrc, botyard.json, package.json, src/, src/index.js
    await expect(
      scaffold({ ...base, targetDir, hooks: { afterCreate: failAt(6, meddle) } })
    ).rejects.toThrow("boom")
    expect(await listFiles(targetDir)).toEqual(["src/theirs.js", "theirs.txt"])
  })

  test("keeps a file another process put in place of one of ours", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const meddle = async (): Promise<void> => {
      const replacement = path.join(cwd, "replacement")
      await writeFile(replacement, "theirs")
      await rename(replacement, path.join(targetDir, "botyard.json"))
    }
    await expect(
      scaffold({ ...base, targetDir, hooks: { afterCreate: failAt(4, meddle) } })
    ).rejects.toThrow("boom")
    expect(await listFiles(targetDir)).toEqual(["botyard.json"])
    expect(await readFile(path.join(targetDir, "botyard.json"), "utf8")).toBe("theirs")
  })

  test("keeps sibling directories in a parent it created", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "apps", "my-app")
    const meddle = async (): Promise<void> => {
      await mkdir(path.join(cwd, "apps", "other"))
      await writeFile(path.join(cwd, "apps", "other", "x"), "theirs")
    }
    await expect(
      scaffold({ ...base, targetDir, hooks: { afterCreate: failAt(1, meddle) } })
    ).rejects.toThrow("boom")
    expect(await listFiles(cwd)).toEqual(["apps/other/x"])
  })
})

describe("partial writes", () => {
  test("a file whose write fails is removed with the rest", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const beforeWrite = async (file: string): Promise<void> => {
      if (file.endsWith("package.json")) throw Object.assign(new Error("EFBIG"), { code: "EFBIG" })
    }
    await expect(scaffold({ ...base, targetDir, hooks: { beforeWrite } })).rejects.toThrow(
      ScaffoldError
    )
    expect(await readdir(cwd)).toEqual([])
  })
})

describe("swapped ancestors", () => {
  test("the target swapped for a symlink mid-run is a failure, not a success", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const elsewhere = path.join(cwd, "elsewhere")
    await mkdir(elsewhere)
    const swap = async (file: string): Promise<void> => {
      if (!file.endsWith(".gitignore")) return
      await rename(targetDir, path.join(cwd, "moved"))
      await symlink(elsewhere, targetDir)
    }
    await expect(scaffold({ ...base, targetDir, hooks: { afterCreate: swap } })).rejects.toThrow(
      "changed while scaffolding"
    )
    // What it wrote through the link is rolled back by inode; the moved
    // directory keeps the one file written before the swap.
    expect(await listFiles(elsewhere)).toEqual([])
    expect(await listFiles(path.join(cwd, "moved"))).toEqual([".gitignore"])
  })

  test("a nested directory swapped for a symlink mid-run is a failure", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const elsewhere = path.join(cwd, "elsewhere")
    await mkdir(elsewhere)
    const swap = async (file: string): Promise<void> => {
      if (file !== path.join(targetDir, "src")) return
      await rename(file, path.join(cwd, "moved-src"))
      await symlink(elsewhere, file)
    }
    await expect(scaffold({ ...base, targetDir, hooks: { afterCreate: swap } })).rejects.toThrow(
      "changed while scaffolding"
    )
    expect(await listFiles(elsewhere)).toEqual([])
  })

  // The documented limit: a swap that is reverted before a later failure can
  // leave new files where it pointed. Nothing there is overwritten or deleted,
  // and the run still fails.
  test("a transient target swap before a failure leaves new files outside, nothing worse", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const moved = path.join(cwd, "moved")
    const elsewhere = path.join(cwd, "elsewhere")
    await mkdir(elsewhere)
    await writeFile(path.join(elsewhere, "theirs.txt"), "theirs")
    const meddle = async (file: string): Promise<void> => {
      if (file.endsWith(".gitignore")) {
        await rename(targetDir, moved)
        await symlink(elsewhere, targetDir)
      } else if (file.endsWith(".npmrc")) {
        await unlink(targetDir)
        await rename(moved, targetDir)
        throw new Error("boom")
      }
    }
    await expect(scaffold({ ...base, targetDir, hooks: { afterCreate: meddle } })).rejects.toThrow(
      "boom"
    )
    expect(await readFile(path.join(elsewhere, "theirs.txt"), "utf8")).toBe("theirs")
    expect(await listFiles(elsewhere)).toEqual([".npmrc", "theirs.txt"])
  })

  test("an existing target swapped after its check is a failure", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    await mkdir(targetDir)
    const elsewhere = path.join(cwd, "elsewhere")
    await mkdir(elsewhere)
    const swap = async (file: string): Promise<void> => {
      if (!file.endsWith("package.json")) return
      await rename(targetDir, path.join(cwd, "moved"))
      await symlink(elsewhere, targetDir)
    }
    await expect(scaffold({ ...base, targetDir, hooks: { afterCreate: swap } })).rejects.toThrow(
      "changed while scaffolding"
    )
  })
})

describe("concurrent writers", () => {
  test("a target created after the check is used only if still empty", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const beforeTarget = async (): Promise<void> => {
      await mkdir(targetDir)
      await writeFile(path.join(targetDir, "theirs.txt"), "theirs")
    }
    await expect(scaffold({ ...base, targetDir, hooks: { beforeTarget } })).rejects.toThrow(
      "is not empty"
    )
    expect(await listFiles(targetDir)).toEqual(["theirs.txt"])
  })

  test("a symlink planted at a path it is about to write is not followed", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const victim = path.join(cwd, "victim.json")
    await writeFile(victim, "untouched")
    // After .npmrc (2nd), plant botyard.json (3rd) as a symlink to the victim.
    const plant = async (file: string): Promise<void> => {
      if (file.endsWith(".npmrc")) await symlink(victim, path.join(targetDir, "botyard.json"))
    }
    const error = await scaffold({ ...base, targetDir, hooks: { afterCreate: plant } }).catch(
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(ScaffoldError)
    expect(String(error)).toContain("botyard.json appeared while scaffolding")
    expect(await readFile(victim, "utf8")).toBe("untouched")
    // Ours removed; the planted link is not ours and stays.
    expect(await readdir(targetDir)).toEqual(["botyard.json"])
  })

  test("a file planted where it is about to write is never overwritten", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const plant = async (file: string): Promise<void> => {
      if (file.endsWith("botyard.json")) {
        await writeFile(path.join(targetDir, "package.json"), "theirs")
      }
    }
    await expect(scaffold({ ...base, targetDir, hooks: { afterCreate: plant } })).rejects.toThrow(
      "package.json appeared while scaffolding"
    )
    expect(await listFiles(targetDir)).toEqual(["package.json"])
    expect(await readFile(path.join(targetDir, "package.json"), "utf8")).toBe("theirs")
  })
})

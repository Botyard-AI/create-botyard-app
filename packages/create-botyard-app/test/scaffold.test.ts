// Deterministic interleavings with another process writing to the same target,
// driven through the scaffolder's hooks.
import { mkdir, readdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { scaffold, ScaffoldError } from "../src/scaffold.ts"
import { fixtureTemplates, listFiles, readJson, tempDir } from "./helpers.ts"

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

describe("on failure", () => {
  // Plan order: .gitignore, .npmrc, botyard.json, package.json, src/, src/index.js
  test("leaves what it created, and says so", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const beforeWrite = async (file: string): Promise<void> => {
      if (file.endsWith("package.json")) throw Object.assign(new Error("EFBIG"), { code: "EFBIG" })
    }
    const error = await scaffold({ ...base, targetDir, hooks: { beforeWrite } }).catch(
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(ScaffoldError)
    expect(String(error)).toContain(
      "Nothing was overwritten or deleted. Before it stopped, this run created " +
        `${targetDir} itself and these paths in it:\n` +
        "  .gitignore\n  .npmrc\n  botyard.json\n  package.json\n" +
        "This is a record of what this run created, not of what is there now"
    )
    // The partial package.json is reported, not removed.
    expect(await listFiles(targetDir)).toEqual([
      ".gitignore",
      ".npmrc",
      "botyard.json",
      "package.json",
    ])
  })

  test("an empty target it was given is left as it is", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    await mkdir(targetDir)
    await expect(
      scaffold({ ...base, targetDir, hooks: { afterCreate: failAt(4) } })
    ).rejects.toThrow("boom")
    expect(await listFiles(targetDir)).toEqual([
      ".gitignore",
      ".npmrc",
      "botyard.json",
      "package.json",
    ])
  })

  test("a failure before anything is created lists nothing", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const beforeTarget = async (): Promise<void> => {
      await writeFile(targetDir, "theirs")
    }
    const error = await scaffold({ ...base, targetDir, hooks: { beforeTarget } }).catch(
      (err: unknown) => err
    )
    expect(String(error)).toContain("exists and is not a directory")
    expect(String(error)).not.toContain("this run created")
    expect(await readFile(targetDir, "utf8")).toBe("theirs")
  })

  // Rivet's case: an empty target we were given, and another process's file
  // planted where we were about to write. The guidance names only our entries.
  test("lists only its own entries, never another process's file", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    await mkdir(targetDir)
    const plant = async (file: string): Promise<void> => {
      if (file.endsWith(".npmrc")) await writeFile(path.join(targetDir, "botyard.json"), "theirs")
    }
    const error = await scaffold({ ...base, targetDir, hooks: { afterCreate: plant } }).catch(
      (err: unknown) => err
    )
    const message = String(error)
    expect(message).toContain("botyard.json appeared while scaffolding")
    expect(message).toContain(
      `this run created these paths in ${targetDir}:\n  .gitignore\n  .npmrc\nThis is a record`
    )
    expect(message).not.toContain("itself")
    expect(message).not.toMatch(/delete (it|the)/i)
    expect(await readFile(path.join(targetDir, "botyard.json"), "utf8")).toBe("theirs")
  })

  // Rivet's round-6 cases: a listed path is a history, not ownership.
  const WARNING =
    "another process may since have replaced any of these paths or added files inside them"

  test("a listed file replaced by another process is not presented as ours to remove", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const meddle = async (file: string): Promise<void> => {
      if (file.endsWith(".gitignore")) {
        await rename(file, path.join(cwd, "ours-aside"))
        await writeFile(file, "theirs")
        await writeFile(path.join(targetDir, ".npmrc"), "theirs too")
      }
    }
    const error = await scaffold({ ...base, targetDir, hooks: { afterCreate: meddle } }).catch(
      (err: unknown) => err
    )
    const message = String(error)
    expect(message).toContain(".npmrc appeared while scaffolding")
    expect(message).toContain("  .gitignore\n")
    expect(message).toContain(WARNING)
    expect(message).toContain("Check what is at each path before removing anything")
    expect(message).not.toMatch(/can (safely )?be removed|safe to remove/i)
    expect(await readFile(path.join(targetDir, ".gitignore"), "utf8")).toBe("theirs")
  })

  test("a listed directory with another process's file inside is flagged", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const beforeWrite = async (file: string): Promise<void> => {
      if (file.endsWith("index.js")) {
        await writeFile(path.join(targetDir, "src", "theirs.js"), "theirs")
        throw Object.assign(new Error("EIO"), { code: "EIO" })
      }
    }
    const message = String(
      await scaffold({ ...base, targetDir, hooks: { beforeWrite } }).catch((err: unknown) => err)
    )
    expect(message).toContain("  src/\n")
    expect(message).toContain(WARNING)
    expect(await readFile(path.join(targetDir, "src", "theirs.js"), "utf8")).toBe("theirs")
  })

  // The interval Rivet found in rollback: ours checked, then another process
  // puts its file in place before the delete. There is no delete any more, so
  // whatever is swapped in at the moment of failure survives, and so does ours.
  test("a file swapped in at the moment of failure is never deleted", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const meddle = async (): Promise<void> => {
      await rename(path.join(targetDir, "botyard.json"), path.join(cwd, "ours-aside.json"))
      await writeFile(path.join(targetDir, "botyard.json"), "theirs")
    }
    await expect(
      scaffold({ ...base, targetDir, hooks: { afterCreate: failAt(4, meddle) } })
    ).rejects.toThrow("boom")
    expect(await readFile(path.join(targetDir, "botyard.json"), "utf8")).toBe("theirs")
    expect(await readJson(path.join(cwd, "ours-aside.json"))).toMatchObject({ name: "my-app" })
    expect(await listFiles(targetDir)).toEqual([
      ".gitignore",
      ".npmrc",
      "botyard.json",
      "package.json",
    ])
  })

  test("files another process added are kept", async () => {
    const cwd = await tempDir()
    const targetDir = path.join(cwd, "my-app")
    const meddle = async (): Promise<void> => {
      await writeFile(path.join(targetDir, "theirs.txt"), "theirs")
      await writeFile(path.join(targetDir, "src", "theirs.js"), "theirs")
    }
    await expect(
      scaffold({ ...base, targetDir, hooks: { afterCreate: failAt(6, meddle) } })
    ).rejects.toThrow("boom")
    const files = await listFiles(targetDir)
    expect(files).toContain("theirs.txt")
    expect(files).toContain("src/theirs.js")
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
    // Nothing is deleted: what went through the link stays where it pointed,
    // and the moved directory keeps the file written before the swap.
    expect(await listFiles(elsewhere)).toContain("package.json")
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
    expect(await listFiles(elsewhere)).toEqual(["index.js"])
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
    // Ours stay; the planted link is untouched.
    expect((await readdir(targetDir)).sort((a, b) => a.localeCompare(b))).toEqual([
      ".gitignore",
      ".npmrc",
      "botyard.json",
    ])
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
    expect(await readFile(path.join(targetDir, "package.json"), "utf8")).toBe("theirs")
  })
})

// Removing a path after checking it is ours can never be atomic, so the
// scaffolder must have no way to delete anything at all.
test("the scaffolder has no delete or rename call", async () => {
  const source = await readFile(new URL("../src/scaffold.ts", import.meta.url), "utf8")
  expect(source).not.toMatch(/\b(unlink|rmdir|rm|rename|truncate|ftruncate)\s*\(/)
  expect(source).not.toMatch(/\b(unlink|rmdir|rm|rename|truncate)\b.*from "node:fs/)
})

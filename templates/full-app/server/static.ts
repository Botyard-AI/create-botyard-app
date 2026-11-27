import { constants } from "node:fs"
import { open, readdir, readlink, realpath } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}

type StaticFile = { readonly body: Buffer; readonly type: string }

/** The built UI, read into memory once at startup. */
export type StaticFiles = ReadonlyMap<string, StaticFile>

/** The built UI cannot be loaded safely on this system. */
export class StaticLoadError extends Error {
  override name = "StaticLoadError"
}

type LoadOptions = {
  /** Test seam: runs before each file is opened. */
  beforeOpen?: (file: string) => Promise<void>
  /** Test seam: the kernel's path of an open file, or null. Defaults to /proc. */
  openedPath?: (fd: number) => Promise<string | null>
  /**
   * Files never to serve, by where they really are (the kernel's path of
   * the open file): the app's private files, such as its trace.
   */
  exclude?: (realFile: string) => boolean
}

/**
 * Reads the built UI under `root` into memory, keyed by URL path ("/assets/x.js").
 * Requests are then answered from memory: nothing on disk is opened while the
 * server runs, so changing files under `root` later has no effect until a
 * restart.
 *
 * Only regular files are read; symlinks and unreadable files are skipped.
 * Each file is opened without following a symlink at its own name, then the
 * kernel's path for the open file (/proc/self/fd) must be inside `root`, so a
 * directory swapped for a symlink while loading cannot pull in an outside
 * file. If that path cannot be read (no /proc, as on macOS and Windows, or
 * /proc denied), it throws a StaticLoadError rather than serve a file it
 * cannot place. Use `npm run dev` there.
 */
export async function loadStatic(root: string, options: LoadOptions = {}): Promise<StaticFiles> {
  const { beforeOpen, openedPath = procPath, exclude = () => false } = options
  const realRoot = await realpath(root)
  const files = new Map<string, StaticFile>()
  const walk = async (dir: string, urlPath: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      const url = `${urlPath}/${entry.name}`
      if (entry.isDirectory()) await walk(file, url)
      else if (entry.isFile()) {
        await beforeOpen?.(file)
        const body = await readInside(realRoot, file, openedPath, exclude)
        if (body !== null) {
          files.set(url, {
            body,
            type: TYPES[path.extname(entry.name)] ?? "application/octet-stream",
          })
        }
      }
    }
  }
  await walk(realRoot, "")
  return files
}

/**
 * The file's bytes, or null when it cannot be opened, is not a regular file,
 * is outside `realRoot`, or is excluded. Throws when where it is cannot be determined.
 */
async function readInside(
  realRoot: string,
  file: string,
  openedPath: (fd: number) => Promise<string | null>,
  exclude: (realFile: string) => boolean
): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    if (!(await handle.stat()).isFile()) return null
    const where = await openedPath(handle.fd)
    if (where === null) {
      throw new StaticLoadError(
        `Cannot tell where ${file} really is (this needs /proc/self/fd, on Linux), ` +
          "so the built UI is not served. Bots run on Linux; locally, use `npm run dev`."
      )
    }
    if (!where.startsWith(realRoot + path.sep) || exclude(where)) return null
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** The kernel's path of an open file, from /proc; null when unavailable. */
async function procPath(fd: number): Promise<string | null> {
  if (process.platform !== "linux") return null
  try {
    const where = await readlink(`/proc/self/fd/${String(fd)}`)
    return path.isAbsolute(where) && !where.endsWith(" (deleted)") ? where : null
  } catch {
    return null
  }
}

/**
 * Answers a GET or HEAD for the built UI: a file as it is, or index.html for
 * any other path without a file extension, so client-side routes load the
 * app. Returns false when there is nothing to serve.
 */
export function serveStatic(
  files: StaticFiles,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return false
  }
  // Keys are exact paths, so "..", "//" and the like simply match nothing.
  let file = files.get(decoded)
  let immutable = decoded.startsWith("/assets/")
  if (file === undefined && path.posix.extname(decoded) === "") {
    file = files.get("/index.html")
    immutable = false
  }
  if (file === undefined) return false

  res.writeHead(200, {
    "content-type": file.type,
    "content-length": file.body.length,
    "x-content-type-options": "nosniff",
    // Vite puts content hashes in /assets/ file names, so those never change.
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  })
  res.end(req.method === "HEAD" ? undefined : file.body)
  return true
}

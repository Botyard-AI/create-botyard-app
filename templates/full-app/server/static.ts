import { constants } from "node:fs"
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises"
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

/**
 * Reads the built UI under `root` into memory, keyed by URL path ("/assets/x.js").
 * Requests are then answered from memory: nothing on disk is opened while the
 * server runs, so changing files under `root` later has no effect until a
 * restart.
 *
 * Only regular files are read. Symlinks are skipped, and so are files that
 * cannot be read. Each file is opened without following a symlink at its own
 * name; on Linux the opened file's real path is then read back from the kernel
 * (/proc/self/fd) and the file is kept only if it is inside `root`, so a
 * directory swapped for a symlink while loading cannot pull in an outside
 * file. Without /proc (macOS, Windows) the file must be the one listed at that
 * path, which does not catch such a swap; there, as everywhere, whoever can
 * rename directories under `root` can also replace the UI itself.
 */
export async function loadStatic(
  root: string,
  /** Test seam: runs before each file is opened. */
  beforeOpen?: (file: string) => Promise<void>
): Promise<StaticFiles> {
  const realRoot = await realpath(root)
  const files = new Map<string, StaticFile>()
  const walk = async (dir: string, urlPath: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      const url = `${urlPath}/${entry.name}`
      if (entry.isDirectory()) await walk(file, url)
      else if (entry.isFile()) {
        await beforeOpen?.(file)
        const body = await readInside(realRoot, file)
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

/** The file's bytes, or null when it is unreadable, not a regular file, or not inside `realRoot`. */
async function readInside(realRoot: string, file: string): Promise<Buffer | null> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) return null
    const where = await openedPath(handle.fd)
    if (where === undefined) {
      // No /proc: fall back to checking it is the file listed at that path.
      const listed = await lstat(file)
      if (listed.dev !== opened.dev || listed.ino !== opened.ino) return null
    } else if (where === null || !where.startsWith(realRoot + path.sep)) {
      return null
    }
    return await handle.readFile()
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** The kernel's path of an open file; undefined without /proc, null if unknown. */
async function openedPath(fd: number): Promise<string | null | undefined> {
  if (process.platform !== "linux") return undefined
  try {
    const where = await readlink(`/proc/self/fd/${String(fd)}`)
    return path.isAbsolute(where) && !where.endsWith(" (deleted)") ? where : null
  } catch {
    return undefined
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

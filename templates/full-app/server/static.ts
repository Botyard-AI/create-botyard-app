import { open, realpath } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import { pipeline } from "node:stream/promises"

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

/**
 * Serves the built UI from `root`: files as they are, and index.html for any
 * other path without a file extension, so client-side routes load the app.
 * Returns false when there is nothing to serve.
 *
 * A file is served only if its real path, after symlinks, is inside the real
 * `root`, and only once it has been opened, so an unreadable file is "not
 * found" rather than a crash.
 */
export async function serveStatic(
  root: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return false
  }
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return false
  }

  const file = await openInside(realRoot, path.join(realRoot, decoded))
  if (file !== null) {
    await send(file, req, res, decoded.startsWith("/assets/"))
    return true
  }
  if (path.extname(decoded) === "") {
    const index = await openInside(realRoot, path.join(realRoot, "index.html"))
    if (index !== null) {
      await send(index, req, res, false)
      return true
    }
  }
  return false
}

type OpenFile = { readonly handle: FileHandle; readonly type: string }

/** Opens `file` if it is a regular file whose real path is inside `realRoot`. */
async function openInside(realRoot: string, file: string): Promise<OpenFile | null> {
  let real: string
  try {
    real = await realpath(file)
  } catch {
    return null
  }
  if (!real.startsWith(realRoot + path.sep)) return null

  let handle: FileHandle
  try {
    handle = await open(real, "r")
  } catch {
    return null
  }
  try {
    if (!(await handle.stat()).isFile()) {
      await handle.close()
      return null
    }
  } catch {
    await handle.close()
    return null
  }
  return { handle, type: TYPES[path.extname(real)] ?? "application/octet-stream" }
}

async function send(
  file: OpenFile,
  req: IncomingMessage,
  res: ServerResponse,
  immutable: boolean
): Promise<void> {
  res.writeHead(200, {
    "content-type": file.type,
    "x-content-type-options": "nosniff",
    // Vite puts content hashes in /assets/ file names, so those never change.
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  })
  if (req.method === "HEAD") {
    await file.handle.close()
    res.end()
    return
  }
  try {
    // pipeline closes the handle's stream and the response on success and on error.
    await pipeline(file.handle.createReadStream(), res)
  } catch {
    // A read error after the headers went out: the response is already
    // destroyed, which the client sees as a truncated body.
  }
}

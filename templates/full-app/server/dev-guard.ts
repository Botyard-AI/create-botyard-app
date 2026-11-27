// Keeps the app's private files out of what `npm run dev` serves.
//
// vite.config.ts denies data/ and index.ts denies the trace files by name
// (server.fs.deny), but Vite checks the name a request asks for, then opens
// that path with symlinks followed. A symlink anywhere in what it serves
// (src/notes.jsonl -> ../data/trace.jsonl, or a link to data/ itself) would
// get past a name check. This plugin checks the file each request would
// really open instead, and refuses it when that is private.
//
// What is private: everything really inside data/, and the trace files,
// wherever TRACE_FILE put them.
import { realpathSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"
import { isInside, realpathIfThere } from "./trace.ts"

type PrivateFiles = {
  /** The app's root, where data/ is. */
  readonly root: string
  /** Files that are private wherever they are, such as the trace's: give their real paths. */
  readonly files: readonly string[]
}

/**
 * True when `file`, with symlinks followed, is private. A file that is not
 * there is not: there is nothing to serve.
 */
export function isPrivate({ root, files }: PrivateFiles, file: string): boolean {
  let real: string
  try {
    real = realpathSync(file)
  } catch {
    return false
  }
  const data = realpathIfThere(path.join(root, "data"))
  return data.some((dir) => isInside(dir, real)) || files.includes(real)
}

/**
 * A Vite plugin that refuses any request that would really open a private
 * file: a 404 before Vite's own middleware runs (static files, public/,
 * /@fs/, and ?raw, ?import, ?url and the like). `load` refuses one too, as a
 * backstop for a module Vite reaches some other way, such as an import in
 * the app's own code.
 */
export function keepPrivate(privateFiles: PrivateFiles): Plugin {
  let publicDir = path.join(privateFiles.root, "public")
  return {
    name: "keep-private",
    enforce: "pre",
    configResolved(config) {
      publicDir = config.publicDir === "" ? publicDir : config.publicDir
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const asked = requestedPath(req.url ?? "/")
        const candidates =
          asked === null
            ? []
            : [
                ...(asked.startsWith("/@fs/") ? [asked.slice("/@fs".length)] : []),
                path.join(privateFiles.root, asked),
                path.join(publicDir, asked),
              ]
        // A path that cannot be decoded is refused too: Vite would refuse it anyway.
        if (asked === null || candidates.some((file) => isPrivate(privateFiles, file))) {
          res.statusCode = 404
          res.end("Not found")
          return
        }
        next()
      })
    },
    load(id) {
      const file = id.split("?")[0] ?? id
      if (path.isAbsolute(file) && isPrivate(privateFiles, file)) {
        throw new Error("Not served: a private file")
      }
      return null
    },
  }
}

/** The request's path, decoded, without its query; null when it cannot be decoded. */
function requestedPath(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url, "http://localhost").pathname)
  } catch {
    return null
  }
}

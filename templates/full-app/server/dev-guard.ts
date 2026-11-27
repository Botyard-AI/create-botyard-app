// Keeps the app's private files out of what `npm run dev` serves. `npm start`
// uses isPrivate too, to leave them out of the built UI it loads (index.ts).
//
// vite.config.ts denies data/ and index.ts denies the trace files by name
// (server.fs.deny), but Vite checks the name a request asks for, then opens
// that path with symlinks followed. A symlink anywhere in what it serves
// (src/notes.jsonl -> ../data/trace.jsonl, or a link to data/ itself) would
// get past a name check. This plugin checks the file each request would
// really open instead, and refuses it when that is private.
//
// What is private: everything really inside data/, and the trace files,
// wherever TRACE_FILE puts them. These are given as names and resolved
// again on every check, so they are kept out whether or not this run's
// trace could be opened, and a file that appears later is kept out too.
import { realpathSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"
import { isInside } from "./trace.ts"

type PrivateFiles = {
  /** The app's root, where data/ is. */
  readonly root: string
  /** Files that are private wherever they are, such as the trace's. */
  readonly files: readonly string[]
}

/** Where `file` really is, or null when that cannot be found out. */
function realpathOrNull(file: string): string | null {
  try {
    return realpathSync(file)
  } catch {
    return null
  }
}

/**
 * True when `file`, with symlinks followed, is private. Never throws.
 *
 * A path that cannot be resolved (missing, a symlink loop, a directory that
 * cannot be searched) cannot be opened through that path either. So:
 * - a requested file that cannot be resolved is not private: Vite cannot
 *   serve it, and a request for something that is not a file (/@vite/client,
 *   a page route) must still reach Vite;
 * - a private name that cannot be resolved names no file right now, so
 *   there is nothing behind it to reach. It is resolved again next time.
 */
export function isPrivate({ root, files }: PrivateFiles, file: string): boolean {
  const real = realpathOrNull(file)
  if (real === null) return false
  const data = realpathOrNull(path.join(root, "data"))
  return (data !== null && isInside(data, real)) || files.some((f) => realpathOrNull(f) === real)
}

/** The `load` hook: refuses a private module, whatever its query; else leaves it to Vite. */
export function refusePrivate(privateFiles: PrivateFiles, id: string): null {
  const file = id.split("?")[0] ?? id
  if (path.isAbsolute(file) && isPrivate(privateFiles, file)) {
    throw new Error("Not served: a private file")
  }
  return null
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
      return refusePrivate(privateFiles, id)
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

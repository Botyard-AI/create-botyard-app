// Approval requests: a member asks another member to approve something; the
// approver approves or rejects it once, with a note; every member of the org
// sees each request and its history.
//
// Add the routes to `api` in server/app.ts. They need the runtime (`tools`)
// for a fresh member listing, so pass it to createApp too; the block's
// install note lists every step.
//
//   const store = new ApprovalStore(path.join(appRoot, "data", "approvals.json"))
//   ...approvalRoutes({ botpage, tools, store }),
//
// Rules for every change:
// - Authority belongs to a member's user id, which never changes. An email
//   address can be given to someone else.
// - Before a change, the viewer (and, for a new request, the approver) is
//   checked against a member listing started after the request body was
//   read, never the cache. The change is then checked, made and saved with
//   no other await, so two decisions on one request cannot both win.
//
// Limits, kept so the example stays readable:
// - One process per data file. Each store loads the file once and rewrites
//   it whole, so two processes sharing a file would overwrite each other.
// - The listing is a recent snapshot, not a lock: someone removed while it
//   is being read can still act once.
import { randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import type { BotPage, MemberViewer, OrgMember } from "@botyard/botpage"
import { BotPageAuthError, MemberDirectory, guardFailure } from "@botyard/botpage"
import { requireMember, sendGuardFailure } from "@botyard/botpage/node"
import type { ToolCaller } from "@botyard/runtime"
import {
  ContractError,
  DECISION_OUTCOME,
  parseApprovalRequests,
  parseDecideApprovals,
  parseNewApproval,
  type ApprovalEvent,
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalsResponse,
  type DecidedResponse,
  type Person,
} from "../src/lib/approvals-contract.ts"

/** The store refuses new requests past this many, so it cannot grow without bound. */
const MAX_REQUESTS = 1000
/** Largest request body read, in bytes. */
const MAX_BODY = 64 * 1024

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** A request the API refuses, with the HTTP status and a message for the person. */
/** The store could not replace its file. Nothing was changed, so trying again is safe. */
export class StoreWriteError extends Error {
  override name = "StoreWriteError"
}

export class HttpError extends Error {
  override name = "HttpError"
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Every request, in memory and, when given a file, on disk. Only one process
 * may use a file. Each change rewrites the whole file: a temporary file,
 * flushed, renamed over the old one, then the directory flushed. The file is
 * never half-written, and a change survives a power cut once `put` reports
 * it durable.
 */
export class ApprovalStore {
  readonly #file: string | null
  readonly #requests = new Map<string, ApprovalRequest>()
  readonly #syncDir: (dir: string) => void

  /**
   * `file` null keeps requests in memory only: they are lost when the app
   * restarts. `syncDir` flushes a directory to disk; tests replace it.
   */
  constructor(file: string | null, { syncDir = fsyncDir } = {}) {
    this.#file = file
    this.#syncDir = syncDir
    for (const request of this.#load()) this.#requests.set(request.id, request)
  }

  /** Newest first. */
  list(): ApprovalRequest[] {
    return [...this.#requests.values()].reverse()
  }

  get(id: string): ApprovalRequest | undefined {
    return this.#requests.get(id)
  }

  get size(): number {
    return this.#requests.size
  }

  /**
   * Adds or replaces requests and saves them together. Synchronous, so
   * nothing runs in between.
   *
   * Throws StoreWriteError when the file could not be replaced: then none
   * of the requests is kept, and the caller may simply try again. Once the file is replaced
   * the change is made, and `put` does not throw. It returns `durable:
   * false` when the directory could not be flushed: the change stands, but
   * a power cut before the disk catches up could still undo it. A store
   * with no file always answers `durable: false`: a restart loses it.
   */
  put(requests: readonly ApprovalRequest[]): { durable: boolean } {
    const before = new Map(this.#requests)
    for (const request of requests) this.#requests.set(request.id, request)
    try {
      this.#write()
    } catch (err) {
      // The file still holds the old list: so must memory.
      this.#requests.clear()
      for (const [id, request] of before) this.#requests.set(id, request)
      throw new StoreWriteError(`could not save ${String(this.#file)}`, { cause: err })
    }
    if (this.#file === null) return { durable: false }
    try {
      this.#syncDir(path.dirname(this.#file))
      return { durable: true }
    } catch (err) {
      // Not an error for the request: failing it would invite a retry that
      // makes the same change twice.
      process.stderr.write(
        `approvals: saved, but could not flush ${path.dirname(this.#file)}: ${String(err)}\n`
      )
      return { durable: false }
    }
  }

  #load(): ApprovalRequest[] {
    if (this.#file === null) return []
    let text: string
    try {
      text = readFileSync(this.#file, "utf8")
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return []
      throw err
    }
    // A file that does not parse stops the app, rather than being replaced.
    return parseApprovalRequests(JSON.parse(text))
  }

  /** Writes a temporary file, flushes it, then renames it over the old one. */
  #write(): void {
    if (this.#file === null) return
    mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 })
    const tmp = `${this.#file}.${String(process.pid)}.tmp`
    const json = JSON.stringify([...this.#requests.values()], null, 2)
    try {
      writeFileSync(tmp, `${json}\n`, { mode: 0o600, flush: true })
      renameSync(tmp, this.#file)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }
}

/** Flushes a directory to disk, so a rename in it survives a power cut. */
function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export type ApprovalDeps = {
  readonly botpage: BotPage
  /** The runtime, for the fresh member listing before each change. */
  readonly tools: ToolCaller
  readonly store: ApprovalStore
}

/** The routes, keyed like `api` in server/app.ts. All are for org members only. */
export function approvalRoutes({ botpage, tools, store }: ApprovalDeps): Record<string, Handler> {
  return {
    "GET /api/approvals": route(botpage, (_req, member): ApprovalsResponse => {
      return { me: member.userId, requests: store.list() }
    }),

    "POST /api/approvals": route(botpage, async (req, member): Promise<ApprovalResponse> => {
      const body = parseNewApproval(await readJson(req))
      if (body.approverId === member.userId) {
        throw new HttpError(400, "Ask someone else: you cannot approve your own request")
      }
      const org = await freshListing(tools)
      // No await from here on: the checks below still hold when the request is saved.
      const requester = stillMember(org, member)
      const approver = org.get(body.approverId)
      if (approver === undefined)
        throw new HttpError(400, "The approver is not a member of this org")
      if (store.size >= MAX_REQUESTS) throw new HttpError(409, "Too many requests are stored")
      const requestedBy = person(requester)
      const request: ApprovalRequest = {
        id: randomUUID(),
        title: body.title,
        details: body.details,
        requestedBy,
        approver: person(approver),
        status: "pending",
        history: [event("requested", requestedBy, "")],
      }
      const { durable } = store.put([request])
      return { durable, request }
    }),

    // A list of decisions, so an approver can clear several at once. All or
    // nothing: each is checked before any is recorded.
    "POST /api/approvals/decide": route(botpage, async (req, member): Promise<DecidedResponse> => {
      const { decisions } = parseDecideApprovals(await readJson(req))
      const org = await freshListing(tools)
      // No await from here on: the requests are read, checked and changed in one step.
      const by = person(stillMember(org, member))
      const decided = decisions.map(({ id, decision, note }): ApprovalRequest => {
        const current = store.get(id)
        if (current === undefined) throw new HttpError(404, `No request ${id}`)
        if (current.approver.userId !== by.userId) {
          throw new HttpError(403, `Only the approver can decide "${current.title}"`)
        }
        if (current.status !== "pending") {
          throw new HttpError(409, `"${current.title}" is already ${current.status}`)
        }
        const outcome = DECISION_OUTCOME[decision]
        return {
          ...current,
          status: outcome,
          history: [...current.history, event(outcome, by, note)],
        }
      })
      const { durable } = store.put(decided)
      return { durable, requests: decided }
    }),
  }
}

/**
 * The org's members, from a listing that starts now rather than the cache.
 * `list_org_members` cannot look up one member, so this lists the whole org:
 * once per change, which is fine at the pace people approve things.
 */
async function freshListing(tools: ToolCaller): Promise<ReadonlyMap<string, OrgMember>> {
  const members = await new MemberDirectory(tools, { maxStaleMs: 0 }).list()
  return new Map(members.map((m) => [m.userId, m]))
}

/** The viewer as the fresh listing has them; refused if it no longer does. */
function stillMember(org: ReadonlyMap<string, OrgMember>, member: MemberViewer): OrgMember {
  const now = org.get(member.userId)
  if (now === undefined) {
    throw new BotPageAuthError("not_a_member", "You are no longer a member of this org.")
  }
  return now
}

function person(member: OrgMember): Person {
  return { userId: member.userId, name: member.name ?? member.email ?? member.userId }
}

function event(kind: ApprovalEvent["kind"], by: Person, note: string): ApprovalEvent {
  return { kind, by, at: new Date().toISOString(), note }
}

/**
 * A members-only route that answers JSON. Refusals become 4xx/503 JSON with
 * an `error` message; anything else is a bug, and is rethrown.
 */
function route<T>(
  botpage: BotPage,
  handler: (req: IncomingMessage, member: MemberViewer) => T | Promise<T>
): Handler {
  return requireMember(botpage, async (req, res, member) => {
    try {
      sendJson(res, 200, await handler(req, member))
    } catch (err) {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message })
      else if (err instanceof ContractError) sendJson(res, 400, { error: err.message })
      else if (err instanceof StoreWriteError) {
        process.stderr.write(`approvals: ${err.message}: ${String(err.cause)}\n`)
        sendJson(res, 503, { error: "Could not save. Nothing was changed: try again." })
      } else {
        const failure = guardFailure(err)
        if (failure === null) throw err
        sendGuardFailure(res, failure)
      }
    }
  })
}

/**
 * Reads a JSON body of at most 64 KiB.
 *
 * Only `application/json` is read. Browsers send that cross-site only after
 * a CORS preflight, which this app never answers, so other sites' pages
 * cannot post here (as long as the Bot Page proxy does not allow
 * credentialed cross-origin requests itself).
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase()
  if (type !== "application/json") {
    throw new HttpError(415, "Send JSON (content-type: application/json)")
  }
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
    throw new HttpError(413, "Request body too large")
  }
  const text = await readBody(req)
  try {
    const json: unknown = JSON.parse(text)
    return json
  } catch {
    throw new HttpError(400, "The body must be JSON")
  }
}

/**
 * The body as text. Past MAX_BODY it stops keeping the bytes and refuses
 * with 413, but goes on reading what is sent (and dropping it), so the
 * client still gets that answer instead of a reset connection.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY) chunks.push(chunk)
      else reject(new HttpError(413, "Request body too large"))
    })
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  })
  res.end(text)
}

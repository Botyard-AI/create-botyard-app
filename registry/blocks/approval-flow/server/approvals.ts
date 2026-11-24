// Approval requests: a member asks another member to approve something; the
// approver approves or rejects it once, with a note; everyone in the org sees
// each request and its history.
//
// Add the routes to `api` in server/app.ts. They need the runtime (`tools`)
// for a fresh member listing, so pass it to createApp too; the block's
// install note lists every step.
//
//   const store = new ApprovalStore(path.join(appRoot, "data", "approvals.json"))
//   ...approvalRoutes({ botpage, tools, store }),
//
// Every org member sees every request. Only the chosen approver decides.
// Two rules hold for every change:
// - Authority belongs to a member's user id, which never changes. An email
//   address can be given to someone else.
// - Before a change, the viewer is checked again against a member listing
//   started after everything the request waited on, never the cache. The
//   change then happens without another await, so a member removed while the
//   request was in flight is refused.
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"
import type { BotPage, MemberViewer, OrgMember } from "@botyard/botpage"
import { BotPageAuthError, MemberDirectory, guardFailure } from "@botyard/botpage"
import { requireMember, sendGuardFailure } from "@botyard/botpage/node"
import type { ToolCaller } from "@botyard/runtime"
import {
  ContractError,
  parseApprovalRequests,
  parseDecideApproval,
  parseNewApproval,
  type ApprovalEvent,
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalsResponse,
  type Person,
} from "../src/lib/approvals-contract.ts"

/** The store refuses new requests past this many, so it cannot grow without bound. */
const MAX_REQUESTS = 1000
/** Largest request body read, in bytes. */
const MAX_BODY = 16 * 1024

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** A request the API refuses, with the HTTP status and a message for the person. */
export class HttpError extends Error {
  override name = "HttpError"
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Every request, in memory and, when given a file, on disk. Each change
 * rewrites the whole file: a temporary file, flushed, then renamed over the
 * old one, so a crash leaves either the old list or the new one.
 */
export class ApprovalStore {
  readonly #file: string | null
  readonly #requests = new Map<string, ApprovalRequest>()

  /** `file` null keeps requests in memory only: they are lost when the app restarts. */
  constructor(file: string | null) {
    this.#file = file
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

  /** Adds or replaces a request and saves. Synchronous, so nothing runs in between. */
  put(request: ApprovalRequest): void {
    const before = this.#requests.get(request.id)
    this.#requests.set(request.id, request)
    try {
      this.#save()
    } catch (err) {
      // Not saved: undo, so memory never holds what the file does not.
      if (before === undefined) this.#requests.delete(request.id)
      else this.#requests.set(request.id, before)
      throw err
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

  #save(): void {
    if (this.#file === null) return
    mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 })
    const tmp = `${this.#file}.${String(process.pid)}.tmp`
    const json = JSON.stringify([...this.#requests.values()], null, 2)
    writeFileSync(tmp, `${json}\n`, { mode: 0o600, flush: true })
    renameSync(tmp, this.#file)
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
      const approver = await botpage.members.lookup(body.approverId)
      if (approver?.userId !== body.approverId) {
        throw new HttpError(400, "The approver is not a member of this org")
      }
      const fresh = await freshMember(tools, member)
      // No await from here on: the checks above still hold when the request is saved.
      if (store.size >= MAX_REQUESTS) throw new HttpError(409, "Too many requests are stored")
      const requestedBy = person(fresh)
      const request: ApprovalRequest = {
        id: randomUUID(),
        title: body.title,
        details: body.details,
        requestedBy,
        approver: person(approver),
        status: "pending",
        history: [event("requested", requestedBy, "")],
      }
      store.put(request)
      return { request }
    }),

    "POST /api/approvals/decide": route(botpage, async (req, member): Promise<ApprovalResponse> => {
      const body = parseDecideApproval(await readJson(req))
      const fresh = await freshMember(tools, member)
      // No await from here on: the request is read and changed in one step.
      const current = store.get(body.id)
      if (current === undefined) throw new HttpError(404, "No such request")
      if (current.approver.userId !== fresh.userId) {
        throw new HttpError(403, "Only the approver can decide this request")
      }
      if (current.status !== "pending") {
        throw new HttpError(409, `This request is already ${current.status}`)
      }
      const approved = body.decision === "approve"
      const request: ApprovalRequest = {
        ...current,
        status: approved ? "approved" : "rejected",
        history: [
          ...current.history,
          event(approved ? "approved" : "rejected", person(fresh), body.note),
        ],
      }
      store.put(request)
      return { request }
    }),
  }
}

/**
 * The member again, from a member listing that starts now, not from the
 * cache. `list_org_members` cannot look up one member, so this lists the
 * whole org: once per change, which is fine for approvals.
 */
async function freshMember(tools: ToolCaller, member: MemberViewer): Promise<OrgMember> {
  const fresh = new MemberDirectory(tools, { maxStaleMs: 0 })
  const now = await fresh.lookup(member.userId)
  if (now?.userId !== member.userId) {
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
      else {
        const failure = guardFailure(err)
        if (failure === null) throw err
        sendGuardFailure(res, failure)
      }
    }
  })
}

/**
 * Reads a JSON body of at most 16 KiB. Requiring `application/json` also
 * keeps other sites' plain HTML forms from posting here.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Send JSON (content-type: application/json)")
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buf.length
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large")
    chunks.push(buf)
  }
  try {
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return json
  } catch {
    throw new HttpError(400, "The body must be JSON")
  }
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

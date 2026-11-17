// The reviewer bot's verdict: verdict.json on its task, read from storage
// through a presigned link, and checked field by field.
//
// The link is a credential for that file. It is fetched only from hosts the
// operator allowed (QUOTE_DESK_FILE_HOSTS), over https, without following
// redirects, within a size and time limit, and it never appears in an error,
// a log line or the UI. Errors are written here, never passed on from fetch or
// the stream, and name the host at most. The bytes must match the SHA-256 the
// platform listed for the file, so what is read is what was listed.
import { createHash } from "node:crypto"
import { DECISIONS } from "../../shared/domain.ts"
import { ParseError, oneOf, record, str } from "../../shared/narrow.ts"
import type { ReviewColumn } from "./workforce.ts"

export const VERDICT_FILE = "verdict.json"
/** verdict.json is a few sentences; anything bigger is not one. */
export const MAX_VERDICT_BYTES = 16 * 1024
const FETCH_TIMEOUT_MS = 10_000

const KEYS = new Set(["quote_id", "decision", "note", "analysis"])

/**
 * A verdict for `quoteId`. Unknown keys are refused, so a typo is an error
 * rather than a silently dropped field. The decision must match the column
 * the reviewer moved the task to.
 */
export function parseVerdict(text: string, quoteId: string, column: ReviewColumn) {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ParseError(`${VERDICT_FILE}: not JSON`)
  }
  const at = VERDICT_FILE
  const r = record(json, at)
  const extra = Object.keys(r).filter((k) => !KEYS.has(k))
  if (extra.length > 0) throw new ParseError(`${at}: unknown field ${extra.join(", ")}`)
  if (str(r, "quote_id", at, 40) !== quoteId)
    throw new ParseError(`${at}: quote_id is not ${quoteId}`)
  const decision = oneOf(r, "decision", DECISIONS, at)
  const expected = column === "approved" ? "approve" : "reject"
  if (decision !== expected)
    throw new ParseError(`${at}: decision "${decision}" but the task is in ${column}`)
  const note = str(r, "note", at, 2000).trim()
  if (note === "") throw new ParseError(`${at}.note: must say why`)
  return {
    decision,
    note,
    analysis: r["analysis"] === undefined ? "" : str(r, "analysis", at, 8000).trim(),
  }
}

export type Verdict = ReturnType<typeof parseVerdict>

/**
 * Fetching verdict.json failed. `refused`: the link breaks a rule and never
 * will work (fall back to manual); `failed`: reading it did not work this
 * time (try again later). The message never contains the link.
 */
export class FileFetchError extends Error {
  override name = "FileFetchError"
  readonly kind: "refused" | "failed"

  constructor(kind: "refused" | "failed", message: string) {
    super(message)
    this.kind = kind
  }
}

/** The hosts verdict links may point at, from QUOTE_DESK_FILE_HOSTS (comma-separated). */
export function fileHosts(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== "")
  )
}

/** The host a link points at, for messages; null if it is not a URL. */
export function hostOf(link: string): string | null {
  try {
    return new URL(link).hostname.toLowerCase()
  } catch {
    return null
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Reads a small file from a presigned link, within the limits above. With
 * `sha256` (hex), the bytes must hash to it.
 */
export async function fetchSmallFile(
  link: string,
  allowed: ReadonlySet<string>,
  fetchImpl: Fetch = fetch,
  sha256: string | null = null
): Promise<string> {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    throw new FileFetchError("refused", "the file link is not a URL")
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== "https:")
    throw new FileFetchError("refused", `the file link on ${host} is not https`)
  if (url.username !== "" || url.password !== "")
    throw new FileFetchError("refused", `the file link on ${host} carries credentials`)
  if (!allowed.has(host))
    throw new FileFetchError("refused", `${host} is not in QUOTE_DESK_FILE_HOSTS`)

  let res: Response
  try {
    res = await fetchImpl(url.href, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json, text/plain" },
    })
  } catch {
    throw new FileFetchError("failed", `${host} could not be read (timeout, redirect or network)`)
  }
  if (!res.ok) throw new FileFetchError("failed", `${host} answered ${String(res.status)}`)
  const bytes = await readCapped(res, host)
  if (sha256 !== null && createHash("sha256").update(bytes).digest("hex") !== sha256.toLowerCase())
    throw new FileFetchError("failed", `the file on ${host} is not the one listed on the task`)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new FileFetchError("refused", `the file on ${host} is not UTF-8 text`)
  }
}

/** The body, up to the cap. Any stream error becomes a FileFetchError of our own. */
async function readCapped(res: Response, host: string): Promise<Buffer> {
  const tooBig = () =>
    new FileFetchError(
      "refused",
      `the file on ${host} is larger than ${String(MAX_VERDICT_BYTES)} bytes`
    )
  const declared = Number(res.headers.get("content-length") ?? "0")
  if (declared > MAX_VERDICT_BYTES) throw tooBig()
  if (res.body === null) return Buffer.alloc(0)
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_VERDICT_BYTES) {
        // Stop reading; whatever cancelling says is not passed on.
        await reader.cancel().catch(() => undefined)
        throw tooBig()
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof FileFetchError) throw err
    // A stream error may quote the link: say only that it broke off.
    throw new FileFetchError("failed", `the download from ${host} broke off`)
  }
  return Buffer.concat(chunks)
}

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { onTestFinished } from "vitest"

import { isRecord } from "../src/internal.ts"

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "botyard-runtime-test-"))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A stand-in for `botyardd`. It appends each invocation (argv and stdin) to
 * `<dir>/invocations.jsonl`, then behaves as `<dir>/behaviour.json` says:
 * `{ exit, stdout?, stderr?, sleepMs? }`.
 */
export async function fakeBotyardd(): Promise<{
  path: string
  behave(b: { exit: number; stdout?: string; stderr?: string; sleepMs?: number }): Promise<void>
  invocations(): Promise<{ argv: string[]; stdin: string }[]>
}> {
  const dir = await tempDir()
  const path = join(dir, "botyardd")
  const log = join(dir, "invocations.jsonl")
  const behaviour = join(dir, "behaviour.json")
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + "\\n");
  const b = JSON.parse(fs.readFileSync(${JSON.stringify(behaviour)}, "utf8"));
  setTimeout(() => {
    if (b.stdout) process.stdout.write(b.stdout);
    if (b.stderr) process.stderr.write(b.stderr);
    process.exitCode = b.exit;
  }, b.sleepMs ?? 0);
});
`
  )
  await chmod(path, 0o755)
  return {
    path,
    behave: (b) => writeFile(behaviour, JSON.stringify(b)),
    invocations: async () => {
      try {
        const text = await readFile(log, "utf8")
        return text.split("\n").filter(Boolean).map(invocation)
      } catch {
        return []
      }
    },
  }
}

export const TOOLS_LIST = JSON.stringify([
  { name: "list_org_members", input_schema: { type: "object" } },
  { name: "create_task", input_schema: { type: "object" } },
])

/** A scripted `fetch` that records requests and answers from a queue. */
export function scriptedFetch(
  answers: ((body: Record<string, unknown>) => Response | Promise<Response>)[]
): {
  fetch: typeof fetch
  requests: Record<string, unknown>[]
} {
  const requests: Record<string, unknown>[] = []
  const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = requestBody(init)
    requests.push(body)
    const answer = answers.shift()
    if (answer === undefined) throw new Error("scriptedFetch: no answer queued")
    return answer(body)
  }
  return { fetch: impl, requests }
}

/** The JSON-RPC request a transport sent, as an object. */
export function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  const body: unknown = JSON.parse(String(init?.body))
  if (!isRecord(body)) throw new Error("the request body is not a JSON object")
  return body
}

/** One line of the fake daemon's invocation log. */
function invocation(line: string): { argv: string[]; stdin: string } {
  const entry: unknown = JSON.parse(line)
  if (!isRecord(entry)) throw new Error(`bad invocation line: ${line}`)
  const { argv, stdin } = entry
  if (
    !Array.isArray(argv) ||
    !argv.every((a) => typeof a === "string") ||
    typeof stdin !== "string"
  ) {
    throw new Error(`bad invocation line: ${line}`)
  }
  return { argv, stdin }
}

export function sse(message: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

export function json(message: unknown, status = 200): Response {
  return new Response(JSON.stringify(message), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** A `tools/list` answer for the given names. */
export function toolsList(
  names: string[],
  extra: Record<string, unknown> = {}
): (body: Record<string, unknown>) => Response {
  return (body) =>
    sse({
      jsonrpc: "2.0",
      id: body["id"],
      result: { tools: names.map((name) => ({ name, inputSchema: { type: "object" } })), ...extra },
    })
}

export function callResult(
  result: Record<string, unknown>
): (body: Record<string, unknown>) => Response {
  return (body) => sse({ jsonrpc: "2.0", id: body["id"], result })
}

export function connectionError(code: string): never {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) })
}

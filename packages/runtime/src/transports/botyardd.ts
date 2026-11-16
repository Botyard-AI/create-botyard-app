/**
 * Native-runtime transport: the `botyardd tools` CLI, which talks to the
 * local daemon over its Unix socket. The daemon holds the bot's identity;
 * this process never sees a credential.
 *
 *   botyardd tools list
 *   botyardd tools call --input - <name>      (arguments as JSON on stdin)
 *
 * `tools call` exit codes (botyard `runtime/botyard-runtime/src/tool_cli.rs`):
 *   0 success, stdout is {content, structured_content?, is_error: false}
 *   3 the tool reported an error, stdout is the same shape with is_error: true
 *   2 invalid input, nothing ran
 *   4 outcome unknown: the tool may have run, never retry
 *   1 any other client failure, nothing ran (the CLI reports anything that
 *     happens after dispatch as 4)
 */

import { spawn } from "node:child_process"

import {
  InvalidInputError,
  OutcomeUnknownError,
  TransportError,
  UnknownToolError,
  type BotyardErrorOptions,
} from "../errors.ts"
import { bounded, deadline, describeEnd, isRecord } from "../internal.ts"
import type { RequestOptions, ToolDescriptor, ToolResult, Transport } from "../types.ts"

export const DEFAULT_BOTYARDD_PATH = "/components/native/current/bin/botyardd"

/** stdout cap. The daemon's own frame limit is 4 MiB. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024
/** stderr cap. The CLI writes one short fixed-string line. */
const MAX_STDERR_BYTES = 8 * 1024
/** Time the CLI gets past its own `--timeout-seconds` before we kill it. */
const KILL_GRACE_MS = 5_000

type BotyarddTransportOptions = {
  /** Path to the `botyardd` binary. */
  readonly path?: string
  /** Environment for the child. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

type RunResult = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** Set when we killed the child (deadline or abort). */
  readonly ended: string | undefined
}

export function createBotyarddTransport(options: BotyarddTransportOptions = {}): Transport {
  const path = options.path ?? DEFAULT_BOTYARDD_PATH
  const env = options.env ?? process.env
  const where = (tool?: string): BotyardErrorOptions => ({ tool, transport: "botyardd" })

  async function run(
    verb: "list" | "call",
    rest: readonly string[],
    stdin: string | undefined,
    opts: RequestOptions
  ): Promise<RunResult> {
    if (opts.signal?.aborted) {
      throw new TransportError("the call was aborted before it started", where())
    }
    const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000))
    const d = deadline(opts.timeoutMs + KILL_GRACE_MS, opts.signal)
    try {
      return await new Promise<RunResult>((resolve, reject) => {
        const child = spawn(path, ["tools", verb, "--timeout-seconds", String(seconds), ...rest], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          signal: d.signal,
          killSignal: "SIGKILL",
        })
        let stdout = ""
        let stdoutBytes = 0
        let stderr = ""
        let overflow = false
        let spawned = false
        let ended: string | undefined
        child.once("spawn", () => {
          spawned = true
        })
        child.stdout.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => {
          stdoutBytes += Buffer.byteLength(chunk)
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            overflow = true
            child.kill("SIGKILL")
            return
          }
          stdout += chunk
        })
        child.stderr.setEncoding("utf8")
        child.stderr.on("data", (chunk: string) => {
          if (stderr.length < MAX_STDERR_BYTES) stderr += chunk
        })
        child.on("error", (err: NodeJS.ErrnoException) => {
          if (err.name === "AbortError") {
            // The 'close' event still follows; record why it ended.
            ended = describeEnd(d)
            return
          }
          if (!spawned) {
            reject(
              new TransportError(`cannot start botyardd at ${path} (${err.code ?? "error"})`, {
                ...where(),
                cause: err,
              })
            )
          }
        })
        child.on("close", (code) => {
          if (overflow) ended = `botyardd output exceeded ${MAX_STDOUT_BYTES} bytes`
          resolve({ code, stdout, stderr: stderr.trim(), ended })
        })
        // EPIPE when the CLI exits before reading stdin (e.g. bad argv) is
        // reported through the exit code; don't let it crash the process.
        child.stdin.on("error", () => undefined)
        child.stdin.end(stdin ?? "")
      })
    } finally {
      d.dispose()
    }
  }

  return {
    kind: "botyardd",

    async listTools(opts) {
      const result = await run("list", [], undefined, opts)
      if (result.ended !== undefined) {
        throw new TransportError(`botyardd tools list did not finish: ${result.ended}`, where())
      }
      if (result.code !== 0) {
        throw new TransportError(
          `botyardd tools list failed (exit ${result.code}): ${bounded(result.stderr || "no detail")}`,
          where()
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch (err) {
        throw new TransportError("botyardd tools list returned unreadable JSON", {
          ...where(),
          cause: err,
        })
      }
      if (!Array.isArray(parsed)) {
        throw new TransportError("botyardd tools list did not return an array", where())
      }
      return parsed.filter(isRecord).flatMap((tool): ToolDescriptor[] => {
        const name = tool["name"]
        if (typeof name !== "string") return []
        const description = tool["description"]
        return [
          {
            name,
            description: typeof description === "string" ? description : undefined,
            inputSchema: tool["input_schema"] ?? tool["inputSchema"],
            outputSchema: tool["output_schema"] ?? tool["outputSchema"],
          },
        ]
      })
    },

    async callTool(name, args, opts) {
      const stdin = JSON.stringify(args)
      const result = await run("call", ["--input", "-", name], stdin, opts)
      if (result.ended !== undefined) {
        throw new OutcomeUnknownError(
          `${result.ended} while botyardd was calling the tool; it may have run. Do not retry automatically.`,
          where(name)
        )
      }
      const detail = bounded(result.stderr || "no detail")
      switch (result.code) {
        case 0:
          return parseOutcome(result.stdout, name, false)
        case 3:
          return parseOutcome(result.stdout, name, true)
        case 2:
          throw new InvalidInputError(`invalid input: ${detail}`, where(name))
        case 4:
          throw new OutcomeUnknownError(`outcome unknown: ${detail}`, where(name))
        case 1:
          if (/unknown or no longer assigned/i.test(result.stderr)) {
            throw new UnknownToolError(
              `tool ${name} is unknown or no longer assigned to this bot`,
              where(name)
            )
          }
          throw new TransportError(`botyardd failed before the tool ran: ${detail}`, where(name))
        case null: // killed by a signal we did not send
        default:
          // Killed by a signal we did not send, or an exit code this version
          // does not know. Nothing proves the tool did not run.
          throw new OutcomeUnknownError(
            `botyardd ended unexpectedly (exit ${result.code ?? "by signal"}): ${detail}`,
            where(name)
          )
      }
    },
  }
}

function parseOutcome(stdout: string, tool: string, isError: boolean): ToolResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    throw new OutcomeUnknownError(
      "botyardd returned an unreadable result after the call; the tool may have run",
      {
        tool,
        transport: "botyardd",
        cause: err,
      }
    )
  }
  if (!isRecord(parsed)) {
    throw new OutcomeUnknownError(
      "botyardd returned a result that is not an object; the tool may have run",
      { tool, transport: "botyardd" }
    )
  }
  const content = parsed["content"]
  const structured =
    "structured_content" in parsed ? parsed["structured_content"] : parsed["structuredContent"]
  return {
    content: Array.isArray(content) ? content : [],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    // The exit code is authoritative; the body agrees with it in every
    // version of the CLI.
    isError,
  }
}

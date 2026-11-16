/**
 * In-memory transport for tests and local development. Never chosen
 * automatically: select it with `transport: "mock"` or
 * `BOTYARD_RUNTIME_TRANSPORT=mock`.
 */

import { readFileSync } from "node:fs"

import { InvalidInputError, OutcomeUnknownError, TransportError } from "../errors.ts"
import { isRecord } from "../internal.ts"
import type { ToolDescriptor, ToolResult, Transport } from "../types.ts"

/** A recorded response for one tool. JSON-serialisable, so it can live in a fixture file. */
export type MockFixture =
  | { readonly result: unknown }
  | {
      readonly error: {
        /**
         * `tool`: the tool ran and returned `isError` (throws `ToolError`).
         * The others throw the matching error without running anything.
         */
        readonly kind: "tool" | "invalid_input" | "outcome_unknown" | "transport"
        readonly message: string
      }
    }

/** Computes a response from the arguments. Throw a `BotyardError` to simulate failures. */
export type MockHandler = (args: Record<string, unknown>) => unknown

export type MockIdentity = {
  readonly id: string
  readonly slug?: string
  readonly name?: string
  readonly org_id?: string
  readonly org_slug?: string
}

export type MockOptions = {
  /**
   * Tools keyed by their *live* name. Use a prefixed key such as
   * `"botyard__list_org_members"` to exercise name resolution.
   */
  readonly tools?: Readonly<Record<string, MockFixture | MockHandler>>
  /** Served as the `get_identity` tool unless `tools` defines one. */
  readonly identity?: MockIdentity
}

/** The shape of a fixture file (`BOTYARD_RUNTIME_MOCK_FIXTURES`). */
export type MockFixtureFile = {
  readonly identity?: MockIdentity
  readonly tools?: Readonly<Record<string, MockFixture>>
}

export type MockCall = {
  readonly tool: string
  readonly args: Record<string, unknown>
}

export type MockTransport = {
  readonly kind: "mock"
  /** Every call that reached the mock, in order, with its live name. */
  readonly calls: readonly MockCall[]
} & Transport

const DEFAULT_MOCK_IDENTITY: MockIdentity = {
  id: "00000000-0000-4000-8000-000000000000",
  slug: "mock-bot",
  name: "Mock Bot",
  org_id: "00000000-0000-4000-8000-000000000001",
  org_slug: "mock-org",
}

export function createMockTransport(options: MockOptions = {}): MockTransport {
  const identity = options.identity ?? DEFAULT_MOCK_IDENTITY
  const tools: Record<string, MockFixture | MockHandler> = {
    get_identity: { result: identity },
    ...options.tools,
  }
  const calls: MockCall[] = []

  return {
    kind: "mock",
    calls,

    async listTools() {
      return Object.keys(tools).map((name): ToolDescriptor => ({
        name,
        inputSchema: { type: "object" },
      }))
    },

    async callTool(name, args, opts) {
      if (opts.signal?.aborted)
        throw new TransportError("the call was aborted before it started", {
          tool: name,
          transport: "mock",
        })
      const entry = tools[name]
      if (entry === undefined)
        throw new TransportError(`mock has no tool ${name}`, { tool: name, transport: "mock" })
      calls.push({ tool: name, args: structuredClone(args) })
      if (typeof entry === "function") return toResult(await entry(args))
      if ("result" in entry) return toResult(entry.result)
      const where = { tool: name, transport: "mock" } as const
      switch (entry.error.kind) {
        case "tool":
          return { content: [{ type: "text", text: entry.error.message }], isError: true }
        case "invalid_input":
          throw new InvalidInputError(entry.error.message, where)
        case "outcome_unknown":
          throw new OutcomeUnknownError(entry.error.message, where)
        case "transport":
          throw new TransportError(entry.error.message, where)
      }
    },
  }
}

function toResult(value: unknown): ToolResult {
  if (value === undefined) return { content: [], isError: false }
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isRecord(value) ? { structuredContent: value } : {}),
    isError: false,
  }
}

/** Load a fixture file. Throws `TransportError` when it is missing or malformed. */
export function loadMockFixtures(path: string): MockOptions {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new TransportError(`cannot read mock fixtures from ${path}`, {
      transport: "mock",
      cause: err,
    })
  }
  if (!isRecord(parsed))
    throw new TransportError(`mock fixtures in ${path} must be a JSON object`, {
      transport: "mock",
    })
  const file = parsed as MockFixtureFile
  return {
    ...(file.identity === undefined ? {} : { identity: file.identity }),
    ...(file.tools === undefined ? {} : { tools: file.tools }),
  }
}

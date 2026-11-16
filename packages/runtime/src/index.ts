/**
 * @botyard/runtime: call Botyard platform tools from a bot app.
 *
 * ```ts
 * import { call, getIdentity } from "@botyard/runtime";
 *
 * const members = await call("list_org_members");
 * ```
 *
 * The transport is chosen automatically: the native daemon (`botyardd`) when
 * its socket exists, else the OpenClaw bridge's loopback MCP proxy. Tests use
 * the mock: `createRuntime({ transport: "mock", mock: { tools: {...} } })`.
 */

import { createRuntime, type Runtime } from "./runtime.ts"
import type { CallOptions, Identity } from "./types.ts"

export {
  BotyardError,
  InvalidInputError,
  OutcomeUnknownError,
  ToolError,
  TransportError,
  UnknownToolError,
  type BotyardErrorOptions,
  type ToolErrorOptions,
} from "./errors.ts"
export {
  createRuntime,
  DEFAULT_TIMEOUT_MS,
  ENV,
  selectTransport,
  type Runtime,
  type RuntimeOptions,
} from "./runtime.ts"
export {
  createMockTransport,
  loadMockFixtures,
  type MockCall,
  type MockFixture,
  type MockFixtureFile,
  type MockHandler,
  type MockIdentity,
  type MockOptions,
  type MockTransport,
} from "./transports/mock.ts"
export type {
  CallOptions,
  Identity,
  RequestOptions,
  ToolCaller,
  ToolDescriptor,
  ToolResult,
  Transport,
  TransportKind,
} from "./types.ts"

let shared: Runtime | undefined

/** The process-wide runtime, created from `process.env` on first use. */
export function defaultRuntime(): Runtime {
  shared ??= createRuntime()
  return shared
}

/** Call a tool on the process-wide runtime. See {@link Runtime.call}. */
export async function call<T = unknown>(
  tool: string,
  args?: Record<string, unknown>,
  opts?: CallOptions
): Promise<T> {
  return defaultRuntime().call<T>(tool, args, opts)
}

/** The bot, its org and the chosen transport, from the process-wide runtime. */
export async function getIdentity(opts?: CallOptions): Promise<Identity> {
  return defaultRuntime().getIdentity(opts)
}

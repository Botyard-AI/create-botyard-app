/**
 * The one capability this package needs from the bot runtime: calling a
 * Botyard platform tool by its canonical, unprefixed name (for example
 * `list_org_members`).
 *
 * The client from `@botyard/runtime` satisfies this interface structurally, so
 * you can pass it straight in. Tests can pass a fake.
 */
export interface CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ToolCaller {
  call<T = unknown>(tool: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<T>
}
